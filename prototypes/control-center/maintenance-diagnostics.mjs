// Operational receipts contain fixed stages, bounded numbers and classified
// failures only. Never copy command stderr, URLs, project text or filesystem
// paths into public maintenance records.
import { publicNativePreflight } from './maintenance-native-preflight.mjs';
export const MAINTENANCE_ATTEMPT_LIMIT = 12;
export const MAINTENANCE_STAGE_LIMIT = 24;
export const MAINTENANCE_STAGES = Object.freeze(['prepare', 'validate_runtime', 'native_preflight', 'waiting_idle', 'stop', 'checkpoint', 'restore', 'validate_target', 'native_preflight_start', 'start', 'verify_successor']);
const checkpointPhases = new Set(['inventory_before', 'validate_state', 'copy', 'inventory_after', 'hash_after', 'verify_payload', 'commit']);
const fields = new Set(['presence', 'order', 'device', 'inode', 'mode', 'size', 'mtime', 'ctime', 'sha256', 'file_type', 'read_length']);
const kinds = new Set(['state', 'secrets', 'subscriptions', 'rna', 'pi', 'genomes', 'initialization', 'evolution', 'capabilities', 'archive', 'observations', 'service', 'other']);
const startupStages = new Set(['recovery_barrier', 'configuration', 'manager_install', 'manager_start', 'wait_status', 'recover_orphan', 'helpers', 'daemon_spawn', 'health']);
const finite = value => Number.isSafeInteger(value) && value >= 0;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
export const boundedElapsed = value => Math.max(0, Math.min(7 * 86400000, Math.round(Number.isFinite(value) ? value : 0)));
export function maintenanceFailureType(error) {
  if (['command_timeout', 'command_exit_nonzero', 'operation_failed'].includes(error?.code) || /^filesystem_(?:enoent|eacces|eperm|enospc|eio|erofs|emfile|ebusy)$/.test(error?.code ?? '')) return error.code;
  if (error?.killed || error?.code === 'ETIMEDOUT' || error?.name === 'TimeoutError') return 'command_timeout';
  if (['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EROFS', 'EMFILE', 'EBUSY'].includes(error?.code)) return `filesystem_${error.code.toLowerCase()}`;
  if (/^(?:maintenance|checkpoint|recovery)_[a-z_]{1,64}$/.test(error?.code ?? '')) return error.code;
  if (Number.isInteger(error?.code)) return 'command_exit_nonzero';
  return 'operation_failed';
}
export function publicCheckpointDiagnostic(value) {
  if (!value || value.schemaVersion !== 1 || !checkpointPhases.has(value.phase)) return undefined;
  const changes = (Array.isArray(value.changes) ? value.changes : []).slice(0, 8).flatMap(row => /^[a-f0-9]{32}$/.test(row?.pathIdentity ?? '') && kinds.has(row.rootKind)
    ? [{ pathIdentity: row.pathIdentity, rootKind: row.rootKind, fields: (Array.isArray(row.fields) ? row.fields : []).filter(field => fields.has(field)).slice(0, 9) }] : []);
  return { schemaVersion: 1, ...(/^[a-f0-9-]{36}$/.test(value.inventoryId ?? '') ? { inventoryId: value.inventoryId } : {}), phase: value.phase, elapsedMs: boundedElapsed(value.elapsedMs), changes,
    totalChanges: finite(value.totalChanges) ? value.totalChanges : changes.length, truncated: value.truncated === true };
}
export function publicStartupReceipt(value) {
  if (value?.schemaVersion !== 1 || !['running', 'completed', 'unconfirmed', 'failed'].includes(value.status)) return undefined;
  const stages = (Array.isArray(value.stages) ? value.stages : []).slice(-12).filter(stage => startupStages.has(stage?.name)).map(stage => ({
    name: stage.name, status: ['running', 'completed', 'failed'].includes(stage.status) ? stage.status : 'unconfirmed',
    ...(finite(stage.elapsedMs) ? { elapsedMs: boundedElapsed(stage.elapsedMs) } : {}),
    ...(stage.failureType ? { failureType: maintenanceFailureType({ code: stage.failureType }) } : {}),
  }));
  return { schemaVersion: 1, status: value.status, ...(finite(value.elapsedMs) ? { elapsedMs: boundedElapsed(value.elapsedMs) } : {}), stages };
}
export function publicMaintenanceAttempts(row) {
  const attempts = (Array.isArray(row?.attempts) ? row.attempts : []).slice(-MAINTENANCE_ATTEMPT_LIMIT).flatMap(attempt => {
    if (!/^[a-f0-9-]{36}$/.test(attempt?.id ?? '') || !finite(attempt.number)) return [];
    const stages = (Array.isArray(attempt.stages) ? attempt.stages : []).slice(-MAINTENANCE_STAGE_LIMIT).filter(stage => MAINTENANCE_STAGES.includes(stage.name)).map(stage => ({
      name: stage.name, status: ['running', 'completed', 'failed', 'unconfirmed'].includes(stage.status) ? stage.status : 'unconfirmed',
      startedAt: date(stage.startedAt),
      ...(finite(stage.elapsedMs) ? { elapsedMs: boundedElapsed(stage.elapsedMs) } : {}),
      ...(stage.failureType ? { failureType: maintenanceFailureType({ code: stage.failureType }) } : {}),
      ...(checkpointPhases.has(stage.checkpointPhase) ? { checkpointPhase: stage.checkpointPhase } : {}),
      ...(stage.reconciled === true ? { reconciled: true } : {}),
      ...(publicStartupReceipt(stage.serviceStartup) ? { serviceStartup: publicStartupReceipt(stage.serviceStartup) } : {}),
      ...(publicStartupReceipt(stage.supervisorStartup) ? { supervisorStartup: publicStartupReceipt(stage.supervisorStartup) } : {}),
      ...(publicCheckpointDiagnostic(stage.checkpoint) ? { checkpoint: publicCheckpointDiagnostic(stage.checkpoint) } : {}),
      ...(publicNativePreflight(stage.nativePreflight) ? { nativePreflight: publicNativePreflight(stage.nativePreflight) } : {}),
    }));
    return [{ id: attempt.id, number: attempt.number, status: ['running', 'completed', 'failed', 'interrupted', 'cancelled'].includes(attempt.status) ? attempt.status : 'interrupted',
      startedAt: date(attempt.startedAt),
      ...(finite(attempt.elapsedMs) ? { elapsedMs: boundedElapsed(attempt.elapsedMs) } : {}), stages }];
  });
  return { attemptCount: finite(row?.attemptCount) ? row.attemptCount : attempts.length, attempts };
}
