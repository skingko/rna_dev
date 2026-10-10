import { basename, dirname, resolve, join } from 'node:path';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { atomicWrite, readJSON } from './durable-files.mjs';
import { acquireProcessLease, processAlive, processBirth } from './process-lease.mjs';
import { publicMaintenanceAttempts } from './maintenance-diagnostics.mjs';

export const MAINTENANCE_PHASES = ['preparing', 'waiting_idle', 'draining', 'checkpointing', 'stopping', 'offline', 'switching', 'verifying', 'completed', 'failed', 'cancelled', 'recovery_required'];
export const maintenanceTerminal = phase => ['completed', 'failed', 'cancelled'].includes(phase);
export const maintenancePaths = stateFile => { const directory = `${resolve(stateFile)}.service`; return { directory, journal: `${directory}/maintenance.json`, records: `${directory}/maintenance-records`, releases: `${directory}/releases`, checkpoints: `${directory}/checkpoints`, registry: `${directory}/maintenance-registry.json`, control: `${directory}/maintenance-control.lock`, worker: `${directory}/maintenance-worker.lock` }; };
/** Validate shared control paths before any lease/metadata writer follows them.
 * Ordinary symlinks in the caller's parent path (for example macOS /var) are
 * canonicalized; owned control roots and files themselves may never be links. */
export function ensureMaintenancePaths(stateFile, { create = false } = {}) {
  if (typeof stateFile !== 'string' || !stateFile || /[\x00-\x1f\x7f]/.test(stateFile)) throw maintenanceFailure('维护状态路径无效。', 'maintenance_unsafe_path');
  const requested = resolve(stateFile), parent = dirname(requested);
  if (create) mkdirSync(parent, { recursive: true, mode: 0o700 });
  let canonicalParent; try { canonicalParent = realpathSync(parent); } catch (cause) { if (!create && cause.code === 'ENOENT') return { stateFile: requested, canonicalStateFile: null, ...maintenancePaths(requested) }; throw cause; }
  const canonical = join(canonicalParent, basename(requested)), paths = maintenancePaths(canonical);
  const inspect = path => { try { return lstatSync(path); } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; } };
  if (create && !inspect(paths.directory)) mkdirSync(paths.directory, { mode: 0o700 });
  for (const path of [paths.directory, paths.records, paths.releases, paths.checkpoints]) {
    const info = inspect(path); if (info && (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o022)) throw maintenanceFailure('维护目录不可写入链接或共享可写目录。', 'maintenance_unsafe_path');
  }
  const locks = [paths.control, paths.worker, join(paths.directory, 'operation.lock'), join(paths.directory, 'supervisor.lock'), `${canonical}.lock`];
  const files = [paths.journal, paths.registry, ...['config.json', 'status.json', 'intent.json', 'drain-receipt.json', 'daemon-stop-receipt.json', 'service-start-receipt.json', 'endurance-request.json'].map(name => join(paths.directory, name)), ...locks.flatMap(path => ['', '.sqlite', '.sqlite-journal', '.sqlite-wal', '.sqlite-shm'].map(suffix => `${path}${suffix}`))];
  for (const path of files) { const info = inspect(path); if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw maintenanceFailure('维护文件与拥有者锁不能是链接或特殊文件。', 'maintenance_unsafe_path'); }
  return { stateFile: requested, canonicalStateFile: canonical, ...paths };
}
export function readMaintenance(stateFile) {
  const paths = maintenancePaths(stateFile);
  // Called by the admission gate every 250 ms. Only its own root and bounded
  // journal need to be read here; mutation paths validate the complete set.
  for (const [path, directory] of [[paths.directory, true], [paths.journal, false]]) {
    let info; try { info = lstatSync(path); } catch (cause) { if (cause.code === 'ENOENT') continue; throw cause; }
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() || info.mode & 0o022 : !info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024)) throw maintenanceFailure('应用维护记录路径无法安全核对。', 'maintenance_unsafe_path');
  }
  const value = readJSON(paths.journal, null);
  if (value && (value.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/.test(value.id ?? '') || !MAINTENANCE_PHASES.includes(value.phase) || typeof value.held !== 'boolean')) throw Object.assign(new Error('应用维护记录无法核对，请使用恢复命令检查。'), { code: 'maintenance_journal_invalid', status: 503 });
  return value;
}
export const maintenanceFailure = (message, code = 'maintenance_unavailable', status = 409) => Object.assign(new Error(message), { code, status });
export function maintenanceOwnerAlive(row) { return Boolean(row?.owner?.pid && row.owner.birth && processAlive(row.owner.pid) && processBirth(row.owner.pid) === row.owner.birth); }
export async function withMaintenanceControl(stateFile, task) { const paths = ensureMaintenancePaths(stateFile, { create: true }); const release = await acquireProcessLease(paths.control); try { return await task(); } finally { release(); } }
export function persistMaintenance(stateFile, value) {
  if (!value || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id ?? '')) throw maintenanceFailure('维护记录身份无效。', 'maintenance_journal_invalid');
  const paths = ensureMaintenancePaths(stateFile, { create: true }), row = { ...value, updatedAt: new Date().toISOString() };
  try { const info = lstatSync(`${paths.records}/${row.id}.json`); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw maintenanceFailure('维护历史路径无法安全核对。', 'maintenance_unsafe_path'); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  atomicWrite(`${paths.records}/${row.id}.json`, JSON.stringify(row));
  atomicWrite(paths.journal, JSON.stringify(row)); return row;
}
export async function changeMaintenance(stateFile, id, change) { return withMaintenanceControl(stateFile, () => { const row = readMaintenance(stateFile); if (row?.id !== id) throw maintenanceFailure('维护请求身份已变化。'); const next = change(structuredClone(row)); return persistMaintenance(stateFile, next); }); }
export function publicMaintenanceOperation(row) { if (!row) return null; row = { ...row, ...publicMaintenanceAttempts(row), candidateId: row.candidateId ?? row.args?.candidateId, ...(row.questionHandoff ? { questionHandoff: { capability: row.questionHandoff.capability, suspended: row.questionHandoff.suspended ?? 0, blocked: row.questionHandoff.blocked ?? 0, phase: row.questionHandoff.phase } } : {}) }; return Object.fromEntries(['id', 'requestId', 'kind', 'phase', 'summary', 'errorCode', 'startedAt', 'updatedAt', 'completedAt', 'checkpointId', 'candidateId', 'cancelRequested', 'questionHandoff', 'attemptCount', 'attempts'].filter(key => row[key] !== undefined).map(key => [key, row[key]])); }
export function initialMaintenance(kind, args, requestId, expected) {
  return { schemaVersion: 1, id: randomUUID(), requestId, requestHash: createHash('sha256').update(JSON.stringify([kind, args])).digest('hex'), kind, args,
    phase: kind === 'prepare' ? 'preparing' : 'waiting_idle', held: kind !== 'prepare', summary: kind === 'prepare' ? '正在检查本地运行包。' : '等待当前工作结束，新任务暂缓接纳。',
    startedAt: new Date().toISOString(), expected, owner: null };
}
/** Only application admission changes. Active turns keep their original signal. */
export class ApplicationMaintenanceGate {
  constructor(store) {
    this.store = store; this.held = false; this.row = null; this.errorCode = null; this.refresh();
    Object.defineProperty(store, 'maintenanceHeld', { configurable: true, get: () => this.held });
    this.timer = setInterval(() => this.refresh(), 250); this.timer.unref();
  }
  refresh() {
    const previous = this.held;
    try { this.row = readMaintenance(this.store.file); this.held = this.row?.held === true; this.errorCode = null; }
    catch { this.held = true; this.errorCode = 'maintenance_journal_invalid'; }
    if (previous !== this.held) for (const listener of this.store.listeners) { try { listener(this.store.state.revision); } catch {} }
  }
  public() { return { protocolVersion: 1, held: this.held, operationId: this.row?.id ?? null, phase: this.row?.phase ?? null, errorCode: this.errorCode }; }
  close() { clearInterval(this.timer); }
}
