import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createConnection } from 'node:net';
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicWrite, readJSON } from './durable-files.mjs';
import { acquireProcessLease, processAlive, processBirth } from './process-lease.mjs';
import { appendRotated } from './endurance-monitor.mjs';

const iso = () => new Date().toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const live = child => child && child.exitCode === null && child.signalCode === null;
const groupAlive = pid => {
  if (process.platform === 'win32') return processAlive(pid);
  try { process.kill(-pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
};
const safeCode = error => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code ?? '') ? error.code : 'HELPER_OPERATION_FAILED';
const fail = (message, code, helperId) => Object.assign(new Error(message), { code, helperId });
const bounded = (value, fallback, min, max) => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw fail('Invalid managed helper timing', 'HELPER_INVALID_DESCRIPTOR');
  return value;
};
const embeddingProbeCodes = new Set(['EMBEDDING_PROBE_OK', 'EMBEDDING_OWNER_MISMATCH', 'EMBEDDING_OWNER_PROBE_TIMEOUT', 'EMBEDDING_OWNER_PROBE_FAILED', 'EMBEDDING_MODEL_NOT_CHECKED', 'EMBEDDING_MODEL_MISSING', 'EMBEDDING_MODEL_IDENTITY_MISMATCH', 'EMBEDDING_MODEL_HTTP', 'EMBEDDING_MODEL_TIMEOUT', 'EMBEDDING_MODEL_UNREACHABLE', 'EMBEDDING_MODEL_RESPONSE_INVALID', 'EMBEDDING_MODEL_RESPONSE_TOO_LARGE']);
for (const code of ['EMBEDDING_WARMUP_PENDING', 'EMBEDDING_WARMUP_NOT_STARTED', 'EMBEDDING_WARMUP_CANCELLED', 'EMBEDDING_WARMUP_TIMEOUT', 'EMBEDDING_WARMUP_UNREACHABLE', 'EMBEDDING_WARMUP_HTTP', 'EMBEDDING_WARMUP_RESPONSE_TOO_LARGE', 'EMBEDDING_WARMUP_RESPONSE_INVALID', 'EMBEDDING_RESIDENT_NOT_CHECKED', 'EMBEDDING_RESIDENT_MISSING', 'EMBEDDING_RESIDENT_IDENTITY_MISMATCH', 'EMBEDDING_RESIDENT_HTTP', 'EMBEDDING_RESIDENT_TIMEOUT', 'EMBEDDING_RESIDENT_UNREACHABLE', 'EMBEDDING_RESIDENT_RESPONSE_INVALID', 'EMBEDDING_RESIDENT_RESPONSE_TOO_LARGE']) embeddingProbeCodes.add(code);
const embeddingReadinessCodes = new Set(['EMBEDDING_PROBE_OK', 'EMBEDDING_CHILD_UNAVAILABLE', 'EMBEDDING_PROBE_PENDING', 'EMBEDDING_PROBE_STALE', 'EMBEDDING_PROBE_FAILED']);
function healthDiagnostic(health) {
  const embedding = health?.embedding, readiness = embedding?.readiness;
  if (!readiness || typeof readiness !== 'object') return undefined;
  const value = {};
  if (embeddingReadinessCodes.has(readiness.code)) value.code = readiness.code;
  if (typeof readiness.probing === 'boolean') value.probing = readiness.probing;
  if (Number.isSafeInteger(readiness.ageMs) && readiness.ageMs >= 0 && readiness.ageMs <= 31536000000) value.ageMs = readiness.ageMs;
  if (Number.isSafeInteger(readiness.maxAgeMs) && readiness.maxAgeMs >= 0 && readiness.maxAgeMs <= 300000) value.maxAgeMs = readiness.maxAgeMs;
  for (const key of ['owner', 'model', 'warmup', 'resident']) {
    const probe = readiness[key]; if (!embeddingProbeCodes.has(probe?.code)) continue;
    value[key] = { code: probe.code };
    if (typeof probe.ok === 'boolean') value[key].ok = probe.ok;
    if (Number.isSafeInteger(probe.elapsedMs) && probe.elapsedMs >= 0 && probe.elapsedMs <= 300000) value[key].elapsedMs = probe.elapsedMs;
    if (Number.isInteger(probe.httpStatus) && probe.httpStatus >= 100 && probe.httpStatus <= 599) value[key].httpStatus = probe.httpStatus;
    if (['netstat', 'lsof'].includes(probe.backend)) value[key].backend = probe.backend;
    if (key === 'warmup' && Number.isSafeInteger(probe.dimensions) && probe.dimensions >= 1 && probe.dimensions <= 65536) value[key].dimensions = probe.dimensions;
  }
  if (!Object.keys(value).length) return undefined;
  if (typeof embedding.childAlive === 'boolean') value.childAlive = embedding.childAlive;
  if (typeof embedding.cleanupUncertain === 'boolean') value.cleanupUncertain = embedding.cleanupUncertain;
  return value;
}
function readinessOnly(diagnostic) {
  if (diagnostic?.childAlive !== true || diagnostic.cleanupUncertain !== false) return false;
  if (['EMBEDDING_PROBE_STALE', 'EMBEDDING_PROBE_PENDING'].includes(diagnostic.code)) return true;
  return diagnostic.code === 'EMBEDDING_PROBE_FAILED' && diagnostic.owner?.ok === true && diagnostic.model?.ok === true
    && diagnostic.warmup?.code === 'EMBEDDING_WARMUP_PENDING';
}
function healthURL(value) {
  let url; try { url = new URL(value); } catch { throw fail('Invalid managed helper health URL', 'HELPER_INVALID_DESCRIPTOR'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw fail('Managed helper health must use a credential-free loopback HTTP URL', 'HELPER_INVALID_DESCRIPTOR');
  return url.href;
}
function normalizeDescriptor(value) {
  if (!value || value.schemaVersion !== 1 || !/^[a-z][a-z0-9-]{0,79}$/.test(value.id ?? '') || value.healthIdentity !== 'rna-helper-v1') throw fail('Managed helper requires a versioned identity descriptor', 'HELPER_INVALID_DESCRIPTOR');
  const allowed = new Set(['schemaVersion', 'id', 'command', 'args', 'cwd', 'healthUrl', 'healthIdentity', 'healthTimeoutMs', 'startupGraceMs', 'configFingerprint']);
  if (Object.keys(value).some(key => !allowed.has(key)) || !isAbsolute(value.command ?? '') || !isAbsolute(value.cwd ?? '') || !Array.isArray(value.args) || value.args.length > 128 || value.args.some(arg => typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) > 16384)) throw fail('Managed helper command, arguments or directory are invalid', 'HELPER_INVALID_DESCRIPTOR', value.id);
  if (value.configFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(value.configFingerprint)) throw fail('Invalid helper configuration fingerprint', 'HELPER_INVALID_DESCRIPTOR', value.id);
  return { schemaVersion: 1, id: value.id, command: value.command, args: [...value.args], cwd: value.cwd, healthUrl: healthURL(value.healthUrl), healthIdentity: value.healthIdentity,
    healthTimeoutMs: bounded(value.healthTimeoutMs, 5000, 20, 5000), startupGraceMs: bounded(value.startupGraceMs, 30000, 0, 300000), ...(value.configFingerprint ? { configFingerprint: value.configFingerprint } : {}) };
}
function loadDescriptor(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw fail('Helper descriptors must be absolute paths', 'HELPER_INVALID_DESCRIPTOR');
  const canonical = realpathSync(path), info = statSync(canonical);
  if (!info.isFile() || info.size > 65536) throw fail('Helper descriptor is not a bounded JSON file', 'HELPER_INVALID_DESCRIPTOR');
  let raw; try { raw = JSON.parse(readFileSync(canonical, 'utf8')); } catch { throw fail('Helper descriptor is not valid JSON', 'HELPER_INVALID_DESCRIPTOR'); }
  const descriptor = normalizeDescriptor(raw);
  if (!statSync(descriptor.command).isFile() || !statSync(descriptor.cwd).isDirectory()) throw fail('Helper executable or directory is unavailable', 'HELPER_INVALID_DESCRIPTOR', descriptor.id);
  return { descriptor, path: canonical, fingerprint: hash(descriptor) };
}
function readOwner(path) {
  try {
    if (lstatSync(`${path}.managed`).isSymbolicLink()) throw fail('Helper runtime directory must not be a symlink', 'HELPER_UNSAFE_PATH');
    const file = join(`${path}.managed`, 'owner.json'), info = lstatSync(file);
    if (!info.isFile() || info.size > 262144) throw fail('Managed helper ownership is not a bounded regular file', 'HELPER_OWNERSHIP_INVALID');
    return readJSON(file);
  } catch (error) { if (error.code === 'ENOENT') return null; throw fail('Managed helper ownership file is unreadable', error.code === 'HELPER_UNSAFE_PATH' ? error.code : 'HELPER_OWNERSHIP_INVALID'); }
}
function ownerDescriptor(owner, path) {
  let descriptor; try { descriptor = normalizeDescriptor(owner?.descriptor); } catch { throw fail('Managed helper ownership descriptor is invalid', 'HELPER_OWNERSHIP_INVALID'); }
  if (owner.schemaVersion !== 1 || owner.id !== descriptor.id || owner.descriptorPath !== path || owner.fingerprint !== hash(descriptor) || typeof owner.token !== 'string' || owner.token.length < 32 || owner.token.length > 256) throw fail('Managed helper ownership does not match the descriptor', 'HELPER_OWNERSHIP_INVALID', descriptor.id);
  return descriptor;
}
function loadCleanupDescriptor(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw fail('Helper descriptors must be absolute paths', 'HELPER_INVALID_DESCRIPTOR');
  // The installed path is canonical. Do not follow a descriptor symlink that
  // may have changed since installation, or require a deleted executable.
  let canonical; try { canonical = join(realpathSync(dirname(path)), basename(path)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const owner = readOwner(canonical);
  if (!owner) return null;
  return { descriptor: ownerDescriptor(owner, canonical), path: canonical, fingerprint: owner.fingerprint };
}
async function listening(url, signal) {
  signal?.throwIfAborted();
  const endpoint = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: endpoint.hostname.replace(/^\[|\]$/g, ''), port: Number(endpoint.port || 80) });
    const finish = (error, value) => { socket.destroy(); signal?.removeEventListener('abort', abort); if (error) reject(error); else resolve(value); };
    const abort = () => finish(signal.reason ?? fail('Helper operation cancelled', 'HELPER_CANCELLED'));
    signal?.addEventListener('abort', abort, { once: true });
    socket.once('connect', () => finish(null, true)); socket.once('error', error => error.code === 'ECONNREFUSED' ? finish(null, false) : finish(fail('Cannot establish whether helper port is free', 'HELPER_PORT_UNKNOWN')));
    socket.setTimeout(500, () => finish(fail('Cannot establish whether helper port is free', 'HELPER_PORT_UNKNOWN')));
  });
}

class ManagedHelper {
  constructor(pool, loaded) {
    this.pool = pool; Object.assign(this, loaded); this.id = this.descriptor.id;
    this.directory = `${this.path}.managed`; this.ownerFile = join(this.directory, 'owner.json');
    this.phase = 'stopped'; this.child = null; this.owner = null; this.restarts = 0; this.failures = 0; this.unhealthy = 0; this.restartableUnhealthy = 0; this.restartDeferred = null; this.crashes = []; this.nextStartAt = 0; this.healthy = false; this.lastIssue = null;
  }
  status() { return { id: this.id, descriptorPath: this.path, fingerprint: this.fingerprint, phase: this.phase, owned: Boolean(this.child && this.owner && this.owner.pid === this.child.pid), healthy: this.healthy, pid: this.child?.pid ?? null, generation: this.owner?.generation ?? null, restarts: this.restarts, consecutiveFailures: this.failures, consecutiveUnhealthy: this.unhealthy, restartableUnhealthy: this.restartableUnhealthy, restartDeferred: this.restartDeferred, cleanupUncertain: this.quarantined === true, nextStartAt: this.nextStartAt ? new Date(this.nextStartAt).toISOString() : null, lastIssue: this.lastIssue, checkedAt: this.checkedAt ?? null }; }
  persist() { atomicWrite(join(this.directory, 'status.json'), JSON.stringify(this.status(), null, 2)); }
  record(event, details = {}) {
    const value = { at: iso(), event, id: this.id, ...details };
    appendRotated(join(this.directory, 'events.jsonl'), `${JSON.stringify(value)}\n`);
    try { this.pool.log(event, { id: this.id, ...details }); } catch { /* An observer cannot alter ownership. */ }
  }
  async start() {
    try { if (lstatSync(this.directory).isSymbolicLink()) throw fail('Helper runtime directory must not be a symlink', 'HELPER_UNSAFE_PATH', this.id); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 }); chmodSync(this.directory, 0o700);
    try { this.release = await acquireProcessLease(join(this.directory, 'controller.lock'), { helperId: this.id, descriptorPath: this.path }); }
    catch { throw fail('This managed helper already has a controller or an unverifiable lease', 'HELPER_LOCKED', this.id); }
    await this.recover();
    if (!this.quarantined) this.phase = 'starting'; if (!this.pool.stopOnly && !this.pool.stopping) await this.maybeSpawn(); this.persist();
  }
  async recover() {
    const owner = readOwner(this.path);
    if (!owner) return;
    if (ownerDescriptor(owner, this.path).id !== this.id) throw fail('Managed helper ownership does not match the descriptor', 'HELPER_OWNERSHIP_INVALID', this.id);
    if (owner.phase === 'cleanup_uncertain') {
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw fail('Managed helper cleanup identity is invalid', 'HELPER_OWNERSHIP_INVALID', this.id);
      // A previous controller could not prove that its newly spawned group
      // ended. The numeric PID is only an observation key, never kill authority.
      let remains = true; try { remains = groupAlive(owner.pid) || processAlive(owner.pid); } catch { /* Unknown remains quarantined. */ }
      if (remains) { this.owner = owner; this.quarantined = true; this.phase = 'blocked'; this.lastIssue = { at: iso(), code: 'HELPER_START_CLEANUP_UNCERTAIN' }; return; }
      atomicWrite(this.ownerFile, JSON.stringify({ ...owner, phase: 'recovered', endedAt: iso() }, null, 2)); return;
    }
    if (owner.phase === 'prepared' && !owner.pid) {
      if (await listening(owner.descriptor.healthUrl, this.pool.lifetime.signal)) throw fail('Helper startup was interrupted before durable PID ownership; listener was not adopted', 'HELPER_OWNERSHIP_INCOMPLETE', this.id);
      return;
    }
    if (!owner.pid && owner.phase === 'exited') return;
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw fail('Managed helper PID identity is incomplete', 'HELPER_OWNERSHIP_INVALID', this.id);
    if (!processAlive(owner.pid)) {
      // A process group may outlive its leader. Its numeric ID is not proof of
      // identity once the recorded leader is gone, so never kill or silently
      // start alongside an unverified remaining group.
      if (groupAlive(owner.pid)) throw fail('Helper leader exited before its remaining group could be verified', 'HELPER_GROUP_UNCERTAIN', this.id);
      return;
    }
    if (typeof owner.birth !== 'string' || !owner.birth) throw fail('Managed helper birth identity is incomplete', 'HELPER_OWNERSHIP_INVALID', this.id);
    const birth = processBirth(owner.pid);
    if (!birth || birth !== owner.birth) throw fail('Managed helper PID was reused or its birth identity cannot be verified', 'HELPER_IDENTITY_MISMATCH', this.id);
    this.record('helper_orphan_recovery', { pid: owner.pid, fingerprint: owner.fingerprint });
    // An orphan has no exit callback to retain ownership of its descendants.
    // Kill the verified old group in one operation: TERM could let the leader
    // exit before an uncooperative descendant, losing our birth identity proof.
    // Normal in-memory health recovery and stop still use TERM then KILL.
    if (processAlive(owner.pid) && processBirth(owner.pid) === owner.birth) {
      try { process.kill(process.platform === 'win32' ? owner.pid : -owner.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    const killedAt = Date.now();
    while (groupAlive(owner.pid) && Date.now() - killedAt < this.pool.policy.killWaitMs) await sleep(40);
    if (groupAlive(owner.pid)) throw fail('Owned helper group did not exit after bounded termination', 'HELPER_STOP_TIMEOUT', this.id);
    // Do not signal a group after its recorded leader identity disappeared.
    atomicWrite(this.ownerFile, JSON.stringify({ ...owner, phase: 'recovered', endedAt: iso() }, null, 2));
  }
  async maybeSpawn() {
    if (this.pool.stopping || this.child || this.quarantined || Date.now() < this.nextStartAt) return;
    if (await listening(this.descriptor.healthUrl, this.pool.lifetime.signal)) {
      this.phase = 'blocked'; this.healthy = false; this.lastIssue = { at: iso(), code: 'HELPER_FOREIGN_LISTENER' }; this.nextStartAt = Date.now() + this.pool.policy.restartMaxMs;
      this.record('helper_foreign_listener'); this.persist(); return;
    }
    this.pool.lifetime.signal.throwIfAborted();
    const token = `${randomUUID()}${randomUUID()}`, generation = randomUUID();
    this.owner = { schemaVersion: 1, id: this.id, descriptorPath: this.path, descriptor: this.descriptor, fingerprint: this.fingerprint, generation, token, controllerPid: process.pid, controllerBirth: processBirth(process.pid), phase: 'prepared', pid: null, birth: null, startedAt: iso() };
    atomicWrite(this.ownerFile, JSON.stringify(this.owner, null, 2));
    const child = spawn(this.descriptor.command, this.descriptor.args, { cwd: this.descriptor.cwd, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG,
        RNA_MANAGED_HELPER_ID: this.id, RNA_MANAGED_HELPER_TOKEN: token, RNA_MANAGED_HELPER_FINGERPRINT: this.fingerprint, RNA_MANAGED_HELPER_OWNER_FILE: this.ownerFile } });
    this.child = child; this.healthy = false; this.phase = 'starting'; this.unhealthy = 0; this.restartableUnhealthy = 0; this.restartDeferred = null; this.startedAt = Date.now(); this.restartReason = null; this.nextStartAt = 0;
    this.childDone = new Promise(resolve => { this.resolveChildDone = resolve; });
    let signalFailure;
    const settleSignalFailure = () => {
      if (!signalFailure || signalFailure.settled) return;
      clearTimeout(signalFailure.timer);
      // Darwin killpg can return EPERM when every member is an unreaped
      // zombie. A ChildProcess exit receipt plus an absent group proves the
      // owned termination completed. Never interpret EPERM alone as success,
      // and never send a delayed signal using the old leader PID.
      const ownedExit = this.child === child && !live(child);
      let exited = false;
      try { exited = ownedExit && !groupAlive(child.pid); } catch {}
      signalFailure.settled = true;
      if (exited) {
        try { this.record('helper_signal_exit_reconciled', { pid: child.pid, code: 'EPERM' }); }
        catch (error) { this.pool.fatal(error); }
      } else if (ownedExit && this.restartReason === 'HELPER_IDENTITY_UNAVAILABLE'
        && this.owner?.generation === generation && this.owner.pid === child.pid && !this.owner.birth && this.owner.phase === 'cleanup_uncertain') {
        // This generation never received a running owner. Its real exit is
        // known, but group cleanup is not: let the existing close handler
        // durably quarantine this helper instead of stopping unrelated peers.
        // No later signal or replacement spawn is authorized by this branch.
        try { this.record('helper_signal_cleanup_check', { pid: child.pid, code: 'EPERM', reason: 'HELPER_IDENTITY_UNAVAILABLE' }); }
        catch (error) { this.pool.fatal(error); }
      } else this.pool.fatal(signalFailure.error);
    };
    const ownedSignal = name => {
      if (this.child !== child || !child.pid) return;
      if (signalFailure) return;
      try { if (process.platform === 'win32') child.kill(name); else process.kill(-child.pid, name); }
      catch (error) {
        if (error.code === 'ESRCH') return;
        if (error.code !== 'EPERM' || process.platform === 'win32') { this.pool.fatal(error); return; }
        signalFailure = { error, settled: false, timer: null };
        if (!live(child)) settleSignalFailure();
        else signalFailure.timer = setTimeout(settleSignalFailure, this.pool.policy.killWaitMs);
      }
    };
    this.signalChild = ownedSignal;
    for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
      let buffer = '', flushed = false; const decoder = new StringDecoder('utf8');
      const write = (data, final = false) => {
        if (flushed) return;
        buffer += data; buffer = buffer.split(token).join('[helper identity redacted]');
        const cut = final ? buffer.length : Math.max(0, buffer.length - token.length + 1);
        if (cut) appendRotated(join(this.directory, `${name}.log`), buffer.slice(0, cut), this.pool.logPolicy);
        buffer = buffer.slice(cut); if (final) flushed = true;
      };
      stream.on('data', data => { try { write(decoder.write(data)); } catch (error) { this.pool.fatal(error); } });
      stream.once('close', () => { try { write(decoder.end(), true); } catch (error) { this.pool.fatal(error); } });
    }
    child.once('error', () => { this.lastIssue = { at: iso(), code: 'HELPER_SPAWN_FAILED' }; });
    child.once('exit', () => {
      // A descendant can retain stdout after its root exits. Reap the freshly
      // owned group now, before waiting for close; never use an old PID file.
      if (signalFailure) settleSignalFailure(); else ownedSignal('SIGKILL');
      clearTimeout(this.killTimer);
      this.pipeTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, this.pool.policy.pipeCloseMs);
    });
    child.once('close', async (code, signal) => {
      if (this.child !== child) return;
      if (signalFailure && !signalFailure.settled) settleSignalFailure();
      clearTimeout(this.killTimer); clearTimeout(this.pipeTimer); this.healthy = false;
      try {
        if (this.restartReason === 'HELPER_IDENTITY_UNAVAILABLE') {
          // The immediate exit callback already signalled the directly owned
          // group. Never send delayed signals after its leader can be reaped.
          const deadline = Date.now() + this.pool.policy.killWaitMs;
          let remains = true;
          do {
            try { remains = groupAlive(child.pid); } catch { remains = true; }
            if (!remains || Date.now() >= deadline) break;
            await sleep(40);
          } while (true);
          this.quarantined = remains;
        }
        this.child = null;
        if (this.owner?.generation === generation) atomicWrite(this.ownerFile, JSON.stringify({ ...this.owner, ...(this.quarantined ? { pid: child.pid } : {}), phase: this.quarantined ? 'cleanup_uncertain' : 'exited', endedAt: iso(), exitCode: code, signal }, null, 2));
        this.record('helper_exit', { pid: child.pid, code, signal, reason: this.restartReason });
        if (this.quarantined) { this.phase = 'blocked'; this.nextStartAt = 0; this.lastIssue = { at: iso(), code: 'HELPER_START_CLEANUP_UNCERTAIN' }; this.record('helper_start_quarantined', { pid: child.pid, code: this.lastIssue.code }); }
        else if (this.pool.stopping) this.phase = 'stopped';
        else {
          this.restarts++; this.failures++; const now = Date.now(); this.crashes = [...this.crashes.filter(at => now - at < this.pool.policy.crashWindowMs), now];
          const cooldown = this.crashes.length >= this.pool.policy.maxCrashes ? this.pool.policy.crashCooldownMs : 0;
          this.nextStartAt = now + Math.max(cooldown, Math.min(this.pool.policy.restartMaxMs, this.pool.policy.restartBaseMs * 2 ** Math.min(10, this.failures - 1)));
          this.phase = cooldown ? 'cooldown' : 'backoff'; this.lastIssue = { at: iso(), code: this.restartReason ?? 'HELPER_EXITED' };
        }
        this.persist();
      } catch (error) { this.pool.fatal(error); }
      finally { this.resolveChildDone?.(); }
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    if (this.pool.stopping || this.child !== child || !live(child)) return;
    const birth = processBirth(child.pid);
    if (!birth) {
      // No running owner is published, so a compliant helper cannot start its
      // business child. A transient OS identity probe must not kill unrelated
      // helpers or the daemon; retire only this directly owned new spawn.
      this.owner = { ...this.owner, pid: child.pid };
      this.lastIssue = { at: iso(), code: 'HELPER_IDENTITY_UNAVAILABLE' }; this.terminate('HELPER_IDENTITY_UNAVAILABLE'); return;
    }
    this.owner = { ...this.owner, pid: child.pid, birth, phase: 'running' }; atomicWrite(this.ownerFile, JSON.stringify(this.owner, null, 2));
    this.record('helper_started', { pid: child.pid, fingerprint: this.fingerprint, generation }); this.persist();
  }
  terminate(reason) {
    if (!this.child || this.restartReason) return;
    if (reason === 'HELPER_IDENTITY_UNAVAILABLE') {
      // A controller crash during cleanup must preserve the local quarantine,
      // not leave an incomplete prepared PID that blocks the entire pool.
      this.owner = { ...this.owner, pid: this.child.pid, phase: 'cleanup_uncertain' };
      atomicWrite(this.ownerFile, JSON.stringify(this.owner, null, 2));
    }
    this.restartReason = reason; this.phase = 'draining'; this.healthy = false; this.signalChild('SIGTERM');
    this.killTimer = setTimeout(() => { if (live(this.child)) this.signalChild('SIGKILL'); }, this.pool.policy.shutdownGraceMs);
    this.record('helper_terminate', { reason, ...(this.lastIssue?.healthDiagnostic ? { healthDiagnostic: this.lastIssue.healthDiagnostic } : {}) }); this.persist();
  }
  authenticateBirth(child, owner) {
    if (owner.authenticatedAt) return;
    // Some launchers exec the actual runtime after spawn (notably macOS
    // Python). The initial PID/birth still gates startup; only this generation's
    // authenticated health response may finalize its post-exec identity.
    if (this.child !== child || this.owner !== owner || !live(child) || this.pool.stopping || this.restartReason || owner.pid !== child.pid) return;
    const birth = processBirth(child.pid);
    if (!birth) throw fail('Cannot establish authenticated helper birth identity', 'HELPER_IDENTITY_UNAVAILABLE', this.id);
    if (this.child !== child || this.owner !== owner || !live(child) || this.pool.stopping || this.restartReason) return;
    const authenticated = { ...owner, initialBirth: owner.birth, birth, authenticatedAt: iso() };
    try { atomicWrite(this.ownerFile, JSON.stringify(authenticated, null, 2)); }
    catch (error) {
      // A rename may have committed before directory fsync failed. Keep the
      // in-memory owner aligned for shutdown, but never publish readiness.
      if (error.committed) this.owner = authenticated;
      throw fail('Authenticated helper ownership could not be durably recorded', 'HELPER_IDENTITY_PERSIST_FAILED', this.id);
    }
    this.owner = authenticated;
    this.record('helper_identity_authenticated', { pid: child.pid, generation: owner.generation, birthChanged: birth !== owner.birth });
  }
  async tick() {
    if (this.pool.stopping) return;
    if (!this.child) { await this.maybeSpawn(); return; }
    if (this.restartReason || !this.owner?.pid) return;
    const child = this.child, owner = this.owner;
    let issue;
    try {
      const signal = AbortSignal.any([this.pool.lifetime.signal, AbortSignal.timeout(this.descriptor.healthTimeoutMs)]);
      const response = await fetch(this.descriptor.healthUrl, { signal, redirect: 'error', headers: { Accept: 'application/json' } });
      const reader = response.body?.getReader(); if (!reader) throw fail('Helper health body missing', 'HELPER_HEALTH_INVALID');
      let raw = '', bytes = 0; const decoder = new TextDecoder();
      try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 16384) throw fail('Helper health body too large', 'HELPER_HEALTH_INVALID'); raw += decoder.decode(value, { stream: true }); } raw += decoder.decode(); }
      finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      let health; try { health = JSON.parse(raw); } catch { throw Object.assign(fail('Helper health is not valid JSON', response.ok ? 'HELPER_HEALTH_INVALID' : 'HELPER_HEALTH_HTTP'), { httpStatus: response.status }); }
      const identity = health?.managedHelper;
      if (identity?.id !== this.id || identity?.token !== owner.token || identity?.fingerprint !== this.fingerprint || identity?.pid !== child.pid) throw fail('Health listener does not prove this helper generation', 'HELPER_IDENTITY_MISMATCH');
      if (this.child !== child || this.owner !== owner || !live(child) || this.pool.stopping || this.restartReason) return;
      // A failing helper can still prove its generation. Persist only fixed
      // diagnostic codes after that proof; never store raw health bodies/tokens.
      if (!response.ok || health.ok !== true) throw Object.assign(fail('Helper is not ready', response.ok ? 'HELPER_HEALTH_NOT_READY' : 'HELPER_HEALTH_HTTP'), { httpStatus: response.status, healthDiagnostic: healthDiagnostic(health) });
      try { this.authenticateBirth(child, owner); }
      catch (error) { if (error.code === 'HELPER_IDENTITY_UNAVAILABLE') throw error; this.healthy = false; this.lastIssue = { at: iso(), code: safeCode(error) }; this.pool.fatal(error); return; }
      if (this.child !== child || !live(child) || this.pool.stopping || this.restartReason) return;
      this.healthy = true; this.phase = 'running'; this.unhealthy = 0; this.restartableUnhealthy = 0; this.restartDeferred = null; this.checkedAt = iso();
      if (Date.now() - this.startedAt > this.pool.policy.stableAfterMs) this.failures = 0;
    } catch (error) {
      if (this.pool.stopping || this.child !== child) return;
      issue = safeCode(error); if (['HELPER_OPERATION_FAILED', 'ABORT_ERR'].includes(issue)) issue = 'HELPER_HEALTH_UNREACHABLE';
      const firstFailure = this.healthy || this.lastIssue?.code !== issue;
      this.healthy = false; this.checkedAt = iso(); this.lastIssue = { at: iso(), code: issue, ...(Number.isInteger(error.httpStatus) ? { httpStatus: error.httpStatus } : {}), ...(error.healthDiagnostic ? { healthDiagnostic: error.healthDiagnostic } : {}) };
      if (firstFailure) this.record('helper_health_failed', { code: issue, ...(this.lastIssue.httpStatus ? { httpStatus: this.lastIssue.httpStatus } : {}), ...(this.lastIssue.healthDiagnostic ? { healthDiagnostic: this.lastIssue.healthDiagnostic } : {}) });
      if (Date.now() - this.startedAt >= this.descriptor.startupGraceMs || issue === 'HELPER_IDENTITY_MISMATCH') {
        this.unhealthy++; this.phase = 'unhealthy';
        // Authenticated, responsive readiness is separate from process failure.
        // Expired evidence and bounded in-progress cold loading remain unhealthy,
        // but restarting them discards progress and can create a cold-start loop.
        if (error.httpStatus === 503 && readinessOnly(error.healthDiagnostic)) {
          this.restartableUnhealthy = 0; this.restartDeferred = 'READINESS_PENDING';
        } else {
          this.restartDeferred = null; this.restartableUnhealthy++;
          if (this.restartableUnhealthy >= this.pool.policy.unhealthyThreshold) this.terminate(issue);
        }
      }
    }
    this.persist();
  }
  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      if (this.child) {
        this.terminate('HELPER_STOP'); const child = this.child, done = this.childDone;
        const wait = this.pool.policy.shutdownGraceMs + this.pool.policy.killWaitMs + this.pool.policy.pipeCloseMs;
        let timer;
        try { await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(fail('Helper stop exceeded its deadline', 'HELPER_STOP_TIMEOUT', this.id)), wait); })]); }
        finally { clearTimeout(timer); if (this.child === child && live(child)) this.signalChild('SIGKILL'); }
      }
      this.phase = 'stopped'; this.healthy = false; if (this.release) this.persist();
    })().finally(() => { clearTimeout(this.killTimer); clearTimeout(this.pipeTimer); this.release?.(); this.release = null; });
    return this.stopPromise;
  }
}

/** Explicit descriptor-only dependency pool. A 200 response alone never grants ownership. */
export class ManagedHelpers {
  constructor({ paths = {}, descriptors = [], log = () => {}, onFatal = () => {}, policy = {}, logPolicy = {}, stopOnly = false } = {}) {
    if (!Array.isArray(descriptors) || descriptors.length > 16) throw fail('Expected at most sixteen helper descriptors', 'HELPER_INVALID_DESCRIPTOR');
    this.paths = paths; this.stopOnly = stopOnly; this.log = log; this.onFatal = onFatal; this.logPolicy = logPolicy; this.stopping = false; this.started = false; this.lifetime = new AbortController();
    this.policy = { unhealthyThreshold: 3, shutdownGraceMs: 2000, killWaitMs: 2000, pipeCloseMs: 1000, restartBaseMs: 1000, restartMaxMs: 60000, crashWindowMs: 15 * 60000, maxCrashes: 5, crashCooldownMs: 15 * 60000, stableAfterMs: 5 * 60000, ...policy };
    for (const [key, value] of Object.entries(this.policy)) if (!Number.isInteger(value) || value < 1 || value > 3600000) throw fail(`Invalid helper policy ${key}`, 'HELPER_INVALID_POLICY');
    const loaded = descriptors.map(stopOnly ? loadCleanupDescriptor : loadDescriptor).filter(Boolean), ids = new Set(), files = new Set();
    for (const entry of loaded) { if (ids.has(entry.descriptor.id) || files.has(entry.path)) throw fail('Duplicate managed helper descriptor', 'HELPER_INVALID_DESCRIPTOR'); ids.add(entry.descriptor.id); files.add(entry.path); }
    this.helpers = loaded.map(entry => new ManagedHelper(this, entry));
  }
  status() { const helpers = this.helpers.map(helper => helper.status()); return { healthy: !helpers.length || this.started && !this.stopping && helpers.every(helper => helper.healthy), allReady: !helpers.length || this.started && !this.stopping && helpers.every(helper => helper.owned && helper.healthy), helpers }; }
  fatal(error) { if (this.stopping) return; this.lastError = { code: safeCode(error), helperId: error?.helperId ?? null }; try { this.onFatal(Object.assign(new Error('Managed helper operation failed'), this.lastError)); } catch {} void this.stop().catch(() => {}); }
  async start() {
    if (this.started) return this.status(); if (this.stopping) throw fail('Managed helper pool is stopped', 'HELPER_STOPPED');
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => { try { for (const helper of this.helpers) await helper.start(); this.started = true; return this.status(); } catch (error) { this.stopping = true; this.lifetime.abort(error); await this.cleanup().catch(() => {}); throw error; } })(); return this.startPromise;
  }
  poll() {
    if (!this.started || this.stopping || this.stopOnly) return Promise.resolve(this.status());
    if (this.pollPromise) return this.pollPromise;
    this.pollPromise = (async () => { const outcomes = await Promise.allSettled(this.helpers.map(helper => helper.tick())); for (const result of outcomes) if (result.status === 'rejected' && !this.stopping) this.fatal(result.reason); return this.status(); })().finally(() => { this.pollPromise = null; }); return this.pollPromise;
  }
  cleanup() {
    if (!this.cleanupPromise) this.cleanupPromise = (async () => { const results = await Promise.allSettled(this.helpers.map(helper => helper.stop())); const failure = results.find(result => result.status === 'rejected'); if (failure) throw failure.reason; })();
    return this.cleanupPromise;
  }
  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true; this.lifetime.abort(fail('Managed helper pool stopped', 'HELPER_STOPPED'));
    this.stopPromise = (async () => { await this.startPromise?.catch(() => {}); await this.cleanup(); await this.pollPromise?.catch(() => {}); return this.status(); })(); return this.stopPromise;
  }
}
