#!/usr/bin/env node
/** Foreground, temporary ownership for semantic acceptance; never a production daemon. */
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ManagedHelpers } from '../prototypes/control-center/managed-helpers.mjs';
import { acquireProcessLease, processBirth } from '../prototypes/control-center/process-lease.mjs';
import { atomicWrite, readJSON } from '../prototypes/control-center/durable-files.mjs';

const [directoryArg, ...descriptors] = process.argv.slice(2);
if (!directoryArg || !isAbsolute(directoryArg) || !descriptors.length || descriptors.some(path => !isAbsolute(path))) {
  throw new Error('Usage: openviking-candidate-host.mjs ABSOLUTE_CONTROL_DIRECTORY ABSOLUTE_DESCRIPTOR...');
}
const directory = resolve(directoryArg);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const runId = randomUUID(), birth = processBirth(process.pid);
if (!birth) throw new Error('Cannot establish candidate controller identity');
const release = await acquireProcessLease(join(directory, 'controller.lock'), { runId, purpose: 'temporary-semantic-acceptance' });
const control = join(directory, 'request.json'), statusPath = join(directory, 'status.json');
let stopping = false, errorCode = null, everReady = false;
let pool;
const stop = () => { stopping = true; };
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, stop);
const startedAt = new Date().toISOString();
function persist(phase) {
  const value = { schemaVersion: 1, runId, pid: process.pid, birth, startedAt, phase, errorCode,
    controlPath: control, checkedAt: new Date().toISOString(), managedHelpers: pool?.status() ?? { healthy: false, allReady: false, helpers: [] } };
  atomicWrite(statusPath, JSON.stringify(value, null, 2));
  return value;
}
try {
  pool = new ManagedHelpers({ descriptors, onFatal(error) { errorCode = error.code ?? 'CANDIDATE_HELPER_FAILED'; stopping = true; } });
  persist('starting'); await pool.start();
  while (!stopping) {
    const request = readJSON(control);
    if (request?.runId === runId && request.action === 'stop') { stopping = true; break; }
    await pool.poll();
    if (stopping) break;
    const healthy = pool.status().healthy;
    if (healthy && !everReady) { everReady = true; process.stdout.write(`${JSON.stringify({ event: 'candidate_ready', runId, pid: process.pid, statusPath, controlPath: control })}\n`); }
    persist(healthy ? 'running' : 'degraded');
    if (!everReady && Date.now() - Date.parse(startedAt) > 120000) throw Object.assign(new Error('Candidate readiness deadline exceeded'), { code: 'CANDIDATE_START_TIMEOUT' });
    await delay(1000);
  }
} catch (error) {
  errorCode = /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code ?? '') ? error.code : 'CANDIDATE_CONTROL_FAILED';
  process.exitCode = 1;
} finally {
  stopping = true;
  if (errorCode) process.exitCode = 1;
  try { await pool?.stop(); persist(errorCode ? 'failed' : 'stopped'); }
  catch { process.exitCode = 1; errorCode ??= 'CANDIDATE_STOP_FAILED'; try { persist('failed'); } catch {} }
  finally { release(); }
}
