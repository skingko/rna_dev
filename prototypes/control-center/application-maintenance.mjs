import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { atomicWrite, readJSON } from './durable-files.mjs';
import { maintenancePaths, readMaintenance, maintenanceTerminal, maintenanceOwnerAlive, maintenanceFailure, withMaintenanceControl, persistMaintenance, initialMaintenance, publicMaintenanceOperation } from './application-maintenance-state.mjs';

const root = import.meta.dirname;
export const maintenanceId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function maintenanceRegistry(stateFile) {
  const data = readJSON(maintenancePaths(stateFile).registry, { schemaVersion: 1, candidates: [], checkpoints: [] });
  if (data?.schemaVersion !== 1 || !Array.isArray(data.candidates) || !Array.isArray(data.checkpoints) || [...data.candidates, ...data.checkpoints].some(row => !maintenanceId(row.id))) throw maintenanceFailure('维护目录无法核对。', 'maintenance_registry_invalid');
  return data;
}
export async function registerMaintenanceEntry(stateFile, group, entry) {
  return withMaintenanceControl(stateFile, () => {
    const data = maintenanceRegistry(stateFile);
    if (!['candidates', 'checkpoints'].includes(group) || !maintenanceId(entry.id)) throw maintenanceFailure('无效维护记录。');
    const old = data[group].find(row => row.id === entry.id);
    if (old && JSON.stringify(old) !== JSON.stringify(entry)) throw maintenanceFailure('维护记录身份冲突。');
    if (!old) data[group].push(entry);
    atomicWrite(maintenancePaths(stateFile).registry, JSON.stringify(data)); return entry;
  });
}
export function maintenanceRecords(stateFile) {
  const path = maintenancePaths(stateFile).records;
  if (!existsSync(path)) return [];
  const names = readdirSync(path).filter(name => maintenanceId(name.slice(0, -5)) && name.endsWith('.json'));
  if (names.length > 10000) throw maintenanceFailure('维护历史需要整理，现有操作记录已保留。', 'maintenance_history_limit');
  return names.map(name => readJSON(resolve(path, name))).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}
const requestKey = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value);
function inputs(kind, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !requestKey(input.requestId)) throw maintenanceFailure('维护请求需要唯一 requestId。', 'maintenance_input_invalid', 400);
  const field = ({ prepare: 'source', apply: 'candidateId', rollback: 'candidateId', restore: 'checkpointId', cancel: 'operationId', recover: 'operationId' })[kind];
  if (Object.keys(input).some(key => !['requestId', field].includes(key))) throw maintenanceFailure('维护请求包含未知字段。', 'maintenance_input_invalid', 400);
  if (kind === 'prepare') {
    if (typeof input.source !== 'string' || input.source.length > 4096 || !isAbsolute(input.source) || /[\x00-\x1f\x7f]/.test(input.source)) throw maintenanceFailure('请选择本机应用或运行包目录。', 'maintenance_source_invalid', 400);
    return { source: resolve(input.source) };
  }
  if (field && !maintenanceId(input[field])) throw maintenanceFailure('请选择现有维护记录。', 'maintenance_input_invalid', 400);
  return field ? { [field]: input[field] } : {};
}
export class ApplicationMaintenanceService {
  constructor(store, { gate, health, launch = startMaintenanceWorker } = {}) { this.store = store; this.gate = gate; this.health = health; this.launch = launch; }
  status() {
    this.gate.refresh(); const row = readMaintenance(this.store.file), registry = maintenanceRegistry(this.store.file), health = this.health();
    const records = maintenanceRecords(this.store.file);
    const active = row && !maintenanceTerminal(row.phase), config = readJSON(`${maintenancePaths(this.store.file).directory}/config.json`);
    const managed = Boolean(config?.stateFile === resolve(this.store.file) && config.command && config.cwd && health.process.supervisorRunId);
    return { current: { hostVersion: health.version, sdkVersion: health.sdkVersion, runtimeIdentity: health.runtimeIdentity }, busy: health.workload.activeWork, held: this.gate.held,
      capabilities: { prepare: !active, backup: managed && !active, apply: managed && !active, rollback: managed && !active, restore: managed && !active },
      operation: publicMaintenanceOperation(row), candidates: registry.candidates.map(({ id, hostVersion, sdkVersion, digest, trust, preparedAt, baselineOnly }) => ({ id, hostVersion, sdkVersion, digest, trust, preparedAt, baselineOnly, canApply: !baselineOnly, canRollback: !baselineOnly && records.some(operation => ['apply', 'rollback'].includes(operation.kind) && operation.phase === 'completed' && operation.args.candidateId === id) })),
      checkpoints: registry.checkpoints.map(({ id, createdAt, files, bytes, scope, verified }) => ({ id, createdAt, files, bytes, scope, verified })),
      history: records.slice(0, 32).map(publicMaintenanceOperation) };
  }
  async submit(kind, input) {
    if (!['prepare', 'backup', 'apply', 'rollback', 'restore', 'cancel', 'recover'].includes(kind)) throw maintenanceFailure('未知维护操作。', 'maintenance_input_invalid', 400);
    const args = inputs(kind, input), stateFile = this.store.file;
    let shouldLaunch = false;
    const row = await withMaintenanceControl(stateFile, () => {
      const current = readMaintenance(stateFile);
      if (kind === 'cancel') {
        if (current?.id === args.operationId && current.cancelRequestId === input.requestId) return current;
        if (current?.id !== args.operationId || current.phase !== 'waiting_idle') throw maintenanceFailure('只有等待当前工作结束的操作可以取消。', 'maintenance_cannot_cancel');
        return persistMaintenance(stateFile, { ...current, cancelRequested: true, cancelRequestId: input.requestId });
      }
      if (kind === 'recover') {
        if (current?.id !== args.operationId || maintenanceTerminal(current.phase) || maintenanceOwnerAlive(current)) throw maintenanceFailure('没有可接续的中断维护。', 'maintenance_cannot_recover');
        if (current.restoreCompleted && current.verifiedProcess && current.phase === 'recovery_required') throw maintenanceFailure('已还原的数据需先离线核对，不会自动重放旧任务。运行 rna recovery status 查看恢复指引。', 'restored_state_review');
        shouldLaunch = true; return persistMaintenance(stateFile, { ...current, recoveryRequestId: input.requestId, owner: null });
      }
      const records = maintenanceRecords(stateFile), previous = records.find(row => row.requestId === input.requestId);
      const hash = createHash('sha256').update(JSON.stringify([kind, args])).digest('hex');
      if (previous) {
        if (previous.requestHash !== hash) throw maintenanceFailure('同一请求 ID 不能用于不同操作。', 'maintenance_request_conflict');
        if (!maintenanceTerminal(previous.phase) && current?.id !== previous.id) {
          if (current && !maintenanceTerminal(current.phase)) throw maintenanceFailure('已有应用维护操作。', 'maintenance_busy');
          shouldLaunch = true; return persistMaintenance(stateFile, previous);
        }
        return previous;
      }
      if (current && !maintenanceTerminal(current.phase)) throw maintenanceFailure('已有应用维护操作，请先查看其结果。', 'maintenance_busy');
      if (records.length >= 10000) throw maintenanceFailure('维护历史已达上限，未删除原有操作证据。', 'maintenance_history_limit');
      const registry = maintenanceRegistry(stateFile), health = this.health();
      const config = readJSON(`${maintenancePaths(stateFile).directory}/config.json`);
      if (kind !== 'prepare' && (!config || config.stateFile !== resolve(stateFile) || !health.process.supervisorRunId)) throw maintenanceFailure('此服务尚未由应用管理器托管，请先使用 rna service start。', 'maintenance_unmanaged');
      if (args.candidateId && !registry.candidates.some(row => row.id === args.candidateId && !row.baselineOnly)) throw maintenanceFailure('请选择具备兼容性声明的运行版本。', 'maintenance_candidate_invalid');
      if (kind === 'rollback' && !records.some(row => ['apply', 'rollback'].includes(row.kind) && row.phase === 'completed' && row.args.candidateId === args.candidateId)) throw maintenanceFailure('回退仅支持此实例之前成功使用过的运行版本。', 'maintenance_rollback_unavailable');
      if (args.checkpointId && !registry.checkpoints.some(row => row.id === args.checkpointId && row.verified)) throw maintenanceFailure('恢复点不存在或尚未通过验证。', 'maintenance_checkpoint_invalid');
      const value = initialMaintenance(kind, args, input.requestId, { process: health.process, runtimeIdentity: health.runtimeIdentity, hostVersion: health.version, sdkVersion: health.sdkVersion, nodeVersion: health.node,
        config: kind === 'prepare' ? null : { command: config.command, cwd: config.cwd, port: config.port, manager: config.manager }, stateVersion: this.store.state.version });
      value.checkpointId = kind === 'prepare' ? undefined : randomUUID();
      shouldLaunch = true; return persistMaintenance(stateFile, value);
    });
    this.gate.refresh();
    if (shouldLaunch) {
      try { await this.launch({ stateFile, id: row.id }); }
      catch {
        // A lost spawn acknowledgement is not proof that the child did not
        // start. Leave the journal held and let status/recover reconcile it.
        throw maintenanceFailure('维护请求已保存，后台接收情况待核对，请刷新状态。', 'maintenance_launch_unconfirmed', 503);
      }
    }
    return { operation: publicMaintenanceOperation(row), accepted: true };
  }
}
export async function startMaintenanceWorker({ stateFile, id }) {
  mkdirSync(maintenancePaths(stateFile).directory, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [resolve(root, 'application-maintenance-worker.mjs'), resolve(stateFile), id], { cwd: root, detached: true, stdio: 'ignore', env: process.env });
  await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); }); child.unref();
}
