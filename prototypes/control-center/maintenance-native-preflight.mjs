import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants, closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { NATIVE_PROBE_SOURCE } from './maintenance-native-probe.mjs';
import { ensureSharedNode, verifyPreparedRuntime } from './runtime-release.mjs';

const execute = promisify(execFile), uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value ?? '');
export const NATIVE_PREFLIGHT_CHECKS = Object.freeze(['runtime_directory', 'supervisor_entry', 'host_entry', 'sdk_entry', 'state_directory', 'application_state', 'service_directory', 'service_configuration']);
const codes = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ELOOP', 'EIO', 'READ_FAILED']);
const fail = code => Object.assign(new Error(code), { code });
const xml = value => String(value).replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[char]));
const elapsed = value => Math.max(0, Math.min(60000, Math.round(value)));
export function publicNativePreflight(value) {
  if (value?.schemaVersion !== 1 || value.context !== 'launchd' || !['passed', 'access_denied', 'failed', 'unconfirmed'].includes(value.status)) return undefined;
  return { schemaVersion: 1, context: 'launchd', status: value.status, elapsedMs: elapsed(Number.isFinite(value.elapsedMs) ? value.elapsedMs : 0),
    cleanup: value.cleanup === 'completed' ? 'completed' : 'unconfirmed',
    ...(typeof value.failureType === 'string' && /^maintenance_native_[a-z_]{1,60}$/.test(value.failureType) ? { failureType: value.failureType } : {}),
    checks: (Array.isArray(value.checks) ? value.checks : []).filter(row => NATIVE_PREFLIGHT_CHECKS.includes(row?.name)).slice(0, 8).map(row => ({ name: row.name, ok: row.ok === true, ...(codes.has(row.errorCode) ? { errorCode: row.errorCode } : {}) })) };
}
function readReceipt(path, binding) {
  let fd;
  try {
    const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8192 || info.mode & 0o077 || info.uid !== process.getuid()) throw fail('maintenance_native_receipt_invalid');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd); if (opened.ino !== info.ino || opened.dev !== info.dev) throw fail('maintenance_native_receipt_invalid');
    // A probe from an older release creates the file before writing it: incomplete JSON means "not written yet", read again.
    let value; try { value = JSON.parse(readFileSync(fd, 'utf8')); } catch (error) { if (error instanceof SyntaxError) return null; throw error; }
    if (value?.schemaVersion !== 1 || ['probeId', 'operationId', 'candidateId', 'digest', 'nonce'].some(key => value[key] !== binding[key])
      || !Number.isSafeInteger(value.pid) || value.pid < 1 || !['passed', 'access_denied', 'failed'].includes(value.status)
      || !Array.isArray(value.checks) || value.checks.length !== NATIVE_PREFLIGHT_CHECKS.length
      || value.checks.some((row, index) => row?.name !== NATIVE_PREFLIGHT_CHECKS[index] || typeof row.ok !== 'boolean' || !row.ok && !codes.has(row.errorCode))
      || (value.status === 'passed') !== value.checks.every(row => row.ok)) throw fail('maintenance_native_receipt_invalid');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw fail('maintenance_native_receipt_invalid'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function readLocalJson(path, maxBytes = 1024 * 1024) {
  let fd;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes) throw fail('maintenance_native_input_invalid');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd); if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw fail('maintenance_native_input_invalid');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } catch { throw fail('maintenance_native_input_invalid'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function nativeProbePlist({ label, node, directory, input }) {
  const args = [node, '-e', NATIVE_PROBE_SOURCE, JSON.stringify(input)];
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${args.map(value => `<string>${xml(value)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(directory)}</string><key>EnvironmentVariables</key><dict><key>RNA_NATIVE_PROBE_NONCE</key><string>${xml(input.nonce)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>ProcessType</key><string>Interactive</string><key>ExitTimeOut</key><integer>2</integer><key>Umask</key><integer>63</integer></dict></plist>`;
}
function launchdManager({ target, plist, node, nonce }) {
  const command = async args => {
    try { return { ok: true, ...(await execute('/bin/launchctl', args, { timeout: 5000, maxBuffer: 65536 })) }; }
    catch (error) { return { ok: false, code: error.code, stderr: String(error.stderr ?? ''), stdout: String(error.stdout ?? '') }; }
  };
  return {
    async inspect() {
      const result = await command(['print', target]);
      if (!result.ok) {
        if ([113, 3].includes(result.code) && /Could not find service|No such process/i.test(result.stderr)) return { exists: false };
        throw fail('maintenance_native_inspection_failed');
      }
      const get = name => result.stdout.match(new RegExp(`^\\s*${name} = (.+)$`, 'm'))?.[1];
      return { exists: true, owned: get('program') === node && get('path') === plist && result.stdout.includes(`RNA_NATIVE_PROBE_NONCE => ${nonce}`),
        pid: Number(get('pid')) || null, exited: get('state') === 'not running', exitCode: Number(get('last exit code')) };
    },
    async bootstrap(domain) { const result = await command(['bootstrap', domain, plist]); if (!result.ok) throw fail('maintenance_native_launch_unconfirmed'); },
    async remove() { const result = await command(['bootout', target]); if (!result.ok) throw fail('maintenance_native_cleanup_unconfirmed'); },
  };
}
/** Only native-context reads. No service start/stop, module execution, model,
 * helper, TCC modification or state writes occur in the probe. A pass requires
 * its exact receipt and successful removal of only its own one-shot job. */
export async function nativeRuntimeReadPreflight({ stateFile, target, candidateId, candidateDigest, operationId, io = {} }) {
  if ((io.platform ?? process.platform) !== 'darwin' || target?.manager !== 'native') return { applicable: false };
  if (!uuid(operationId) || !uuid(candidateId) || !/^[a-f0-9]{64}$/.test(candidateDigest ?? '') || ![stateFile, target.command, target.cwd].every(path => isAbsolute(path ?? '') && !/[\x00-\x1f\x7f]/.test(path))) throw fail('maintenance_native_input_invalid');
  const now = io.now ?? (() => performance.now()), sleep = io.sleep ?? (ms => new Promise(done => setTimeout(done, ms))), started = now();
  const timeoutMs = Math.min(60000, Math.max(1, io.timeoutMs ?? 30000)), probeId = randomUUID(), nonce = randomBytes(24).toString('hex');
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'rna-native-read-probe-'))), receipt = join(directory, 'receipt.json'), plist = join(directory, 'probe.plist');
  const label = `local.rna-agent.read-probe.${probeId}`, domain = `gui/${process.getuid()}`;
  const binding = { probeId, operationId, candidateId, digest: candidateDigest, nonce };
  const input = { ...binding, receipt, stateFile, hostDirectory: target.cwd, serviceDirectory: `${stateFile}.service`, sdkEntry: resolve(target.cwd, '../../packages/sdk/src/index.mjs') };
  writeFileSync(plist, nativeProbePlist({ label, node: target.command, directory, input }), { flag: 'wx', mode: 0o600 });
  const manager = io.manager?.({ target: `${domain}/${label}`, plist, node: target.command, nonce, input, directory }) ?? launchdManager({ target: `${domain}/${label}`, plist, node: target.command, nonce });
  let result = { schemaVersion: 1, context: 'launchd', status: 'unconfirmed', checks: [], cleanup: 'unconfirmed' }, submitted = false, observedPid = null, retain = false;
  try {
    if ((await manager.inspect()).exists) throw fail('maintenance_native_job_identity');
    submitted = true; await manager.bootstrap(domain);
    const deadline = now() + timeoutMs;
    for (;;) {
      const job = await manager.inspect();
      if (!job.exists || !job.owned) throw fail('maintenance_native_job_identity');
      if (job.pid) observedPid ??= job.pid;
      if (observedPid && job.pid && observedPid !== job.pid) throw fail('maintenance_native_job_identity');
      const value = readReceipt(receipt, binding);
      if (value) {
        if (observedPid && value.pid !== observedPid) throw fail('maintenance_native_receipt_invalid');
        // A very short lived job can exit before launchctl reports its PID.
        // The private nonce-bound receipt plus owned job's successful exit is
        // required in that case; absence of a live PID alone proves nothing.
        if (job.pid === null && (!job.exited || job.exitCode !== 0)) throw fail('maintenance_native_exit_unconfirmed');
        result = { ...result, status: value.status, checks: value.checks }; break;
      }
      if (job.pid === null && job.exited) throw fail('maintenance_native_entry_failed');
      if (now() >= deadline) throw fail('maintenance_native_probe_timeout');
      await sleep(Math.min(100, Math.max(1, deadline - now())));
    }
  } catch (error) {
    result.failureType = /^maintenance_native_[a-z_]+$/.test(error.code ?? '') ? error.code : 'maintenance_native_probe_failed';
  } finally {
    try {
      const job = await manager.inspect();
      if (job.exists) {
        if (!submitted || !job.owned || observedPid && job.pid && observedPid !== job.pid) throw fail('maintenance_native_cleanup_unconfirmed');
        await manager.remove();
        const deadline = now() + 5000;
        while ((await manager.inspect()).exists) { if (now() >= deadline) throw fail('maintenance_native_cleanup_unconfirmed'); await sleep(50); }
      }
      result.cleanup = 'completed';
    } catch { result.status = 'unconfirmed'; result.failureType = 'maintenance_native_cleanup_unconfirmed'; retain = true; }
    if (!retain) rmSync(directory, { recursive: true, force: true });
  }
  result.elapsedMs = elapsed(now() - started);
  const safe = publicNativePreflight(result);
  if (safe.status !== 'passed' || safe.cleanup !== 'completed') throw Object.assign(fail(safe.status === 'access_denied' ? 'maintenance_native_access_denied' : safe.failureType ?? 'maintenance_native_read_failed'), { nativePreflight: safe });
  return { applicable: true, ...safe };
}

// Bootstrap path for upgrading an older host which cannot yet run this stage.
// Called from the fully verified prepared slot BEFORE submitting apply.
export async function runNativePreflightCli(args) {
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) { if (!['--state', '--candidate', '--digest', '--request-id'].includes(args[i]) || !args[i + 1] || values.has(args[i])) throw fail('maintenance_native_input_invalid'); values.set(args[i], args[i + 1]); }
  const stateFile = values.get('--state'), candidateId = values.get('--candidate'), digest = values.get('--digest'), operationId = values.get('--request-id');
  if (!isAbsolute(stateFile ?? '') || /[\x00-\x1f\x7f]/.test(stateFile) || !uuid(candidateId) || !uuid(operationId) || !/^[a-f0-9]{64}$/.test(digest ?? '')) throw fail('maintenance_native_input_invalid');
  const directory = resolve(`${stateFile}.service/releases`, candidateId);
  const registry = readLocalJson(`${stateFile}.service/maintenance-registry.json`);
  if (!registry.candidates?.some(row => row.id === candidateId && row.digest === digest)) throw fail('maintenance_native_candidate_unregistered');
  const release = verifyPreparedRuntime({ directory, expectedDigest: digest, policy: { allowedDigests: [digest], platform: process.platform, arch: process.arch, hostProtocolVersion: 1, stateVersion: 2, allowedWriteVersions: [2] } });
  const config = readLocalJson(`${stateFile}.service/config.json`, 65536);
  if (!isAbsolute(config.stateFile ?? '') || realpathSync(stateFile) !== realpathSync(config.stateFile) || !['native', 'session', 'foreground', undefined].includes(config.manager)) throw fail('maintenance_native_state_binding');
  const result = await nativeRuntimeReadPreflight({ stateFile, operationId, candidateId, candidateDigest: digest, target: { command: release.paths.sharedNode ? ensureSharedNode(release) : release.paths.node, cwd: release.paths.host, manager: config.manager ?? 'native' } });
  return { ...result, requestId: operationId, candidateId, digest };
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  try { console.log(JSON.stringify(await runNativePreflightCli(process.argv.slice(2)))); }
  catch (error) { console.error(JSON.stringify({ code: /^maintenance_native_[a-z_]+$/.test(error.code ?? '') ? error.code : 'maintenance_native_probe_failed', ...(error.nativePreflight ? { receipt: error.nativePreflight } : {}) })); process.exitCode = 1; }
}
