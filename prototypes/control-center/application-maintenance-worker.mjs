import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, realpathSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { acquireProcessLease, processAlive, processBirth } from './process-lease.mjs';
import { readJSON } from './durable-files.mjs';
import { maintenancePaths, readMaintenance, changeMaintenance, maintenanceTerminal, maintenanceFailure, ensureMaintenancePaths } from './application-maintenance-state.mjs';
import { maintenanceId, maintenanceRegistry, registerMaintenanceEntry } from './application-maintenance.mjs';
import { ensureSharedNode, prepareLocalRuntime, verifyPreparedRuntime } from './runtime-release.mjs';
import { createStateCheckpoint, verifyStateCheckpoint, restoreStateCheckpointOriginal } from './state-checkpoint.mjs';
import { runtimeImplementationIdentity } from './runtime-identity.mjs';
import { boundedElapsed, maintenanceFailureType, publicCheckpointDiagnostic, publicStartupReceipt, MAINTENANCE_ATTEMPT_LIMIT, MAINTENANCE_STAGE_LIMIT } from './maintenance-diagnostics.mjs';
import { nativeRuntimeReadPreflight, publicNativePreflight } from './maintenance-native-preflight.mjs';
import { applyRetention } from './maintenance-retention.mjs';

const execute = promisify(execFile), delay = ms => new Promise(done => setTimeout(done, ms));
const stamp = () => new Date().toISOString();
const summaries = { draining: '当前工作已收尾，准备关闭服务。', stopping: '正在关闭已空闲的服务。', offline: '服务已关闭，正在维护本机状态。', checkpointing: '正在创建并验证恢复点。', switching: '正在切换到已验证的运行版本。', verifying: '正在核对新服务身份与依赖状态。' };
/** Ready to serve after an upgrade even when `ok` is false only because of
 * recorded memory-sync outcomes still being resolved (an unconfirmed write, a
 * retry, a failed summary task): those are reported as memorySyncDegraded and
 * are not a startup failure. Settled losses no longer degrade health at all. */
export function serviceReady(health) {
  return Boolean(health) && health.memorySyncDegraded === true && health.autonomyDegraded !== true && !health.persistence?.failed && !health.process?.closing && !health.scheduler?.lastTickError
    && ['healthy', 'not_required', 'not_monitored'].includes(health.dependencies?.memory?.status);
}
export const releasePolicy = (digest, stateVersion) => ({ allowedDigests: [digest], platform: process.platform, arch: process.arch, hostProtocolVersion: 1, stateVersion, allowedWriteVersions: [2] });
async function healthAt(port, { timeoutMs = 5000 } = {}) {
  try { const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' }); return response.ok ? await response.json() : null; } catch { return null; }
}
async function suspendQuestions(port, input) {
  const response = await fetch(`http://127.0.0.1:${port}/api/maintenance/questions/suspend`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw maintenanceFailure('未能核对等待问题的交接；现有工作保持等待。', 'maintenance_question_unconfirmed');
  return response.json();
}
async function serviceCommand(config, action, stateFile, id) {
  const env = { ...process.env, RNA_AGENT_STATE: stateFile, RNA_AGENT_PORT: String(config.port), RNA_MAINTENANCE_OPERATION: id };
  delete env.PI_FORGE_STATE; delete env.PI_FORGE_PORT;
  const result = await execute(config.command, [resolve(config.cwd, 'service-cli.mjs'), 'service', action, ...(action === 'start' ? [config.manager === 'native' ? '--native' : '--session'] : [])], { cwd: config.cwd, env, timeout: 90000, maxBuffer: 256 * 1024 });
  try { return JSON.parse(result.stdout); } catch { throw maintenanceFailure('服务操作回执无法读取。', 'maintenance_service_receipt_invalid'); }
}
const originalProcess = (health, row) => health?.process?.pid === row.expected.process.pid && health.process.instanceId === row.expected.process.instanceId && health.runtimeIdentity === row.expected.runtimeIdentity;
const heldBy = (health, row) => health?.maintenance?.protocolVersion === 1 && health.maintenance.held === true && health.maintenance.operationId === row.id;
export function assertDrainReceipt(row, receipt, result) {
  const startedAt = Date.parse(row.startedAt), drainedAt = Date.parse(receipt?.at), exitedAt = Date.parse(result?.lastDaemonExit?.at);
  if (receipt?.schemaVersion !== 1 || receipt.drained !== true || !Number.isFinite(startedAt) || !Number.isFinite(drainedAt) || !Number.isFinite(exitedAt) || drainedAt < startedAt || exitedAt < startedAt || receipt.pid !== row.expected.process.pid || receipt.instanceId !== row.expected.process.instanceId || receipt.runtimeIdentity !== row.expected.runtimeIdentity || receipt.maintenanceOperationId !== row.id ||
    !result?.lastDaemonExit || result.lastDaemonExit.pid !== receipt.pid || result.lastDaemonExit.code !== 0 || result.lastDaemonExit.signal !== null || result.lastDaemonExit.generation !== row.expected.process.generation || result.stoppedDaemon?.pid !== receipt.pid || result.stoppedDaemon.generation !== row.expected.process.generation) throw maintenanceFailure('无法证明旧服务已完整收尾；保留恢复点和执行记录。', 'maintenance_drain_unconfirmed');
}
/** Local ownership joins the HTTP identity to actual daemon/supervisor leases.
 * A random healthy listener, or a historical status file, is not a successor. */
export function maintenanceProcessBound(stateFile, health, target) {
  const directory = maintenancePaths(stateFile).directory, config = readJSON(`${directory}/config.json`), status = readJSON(`${directory}/status.json`);
  const owner = readJSON(`${stateFile}.lock`), supervisor = readJSON(`${directory}/supervisor.lock`);
  if (config?.stateFile !== stateFile || config.command !== target.command || config.cwd !== target.cwd || config.port !== target.port || !health?.process || health.process.closing
    || owner?.stateFile !== stateFile || !owner.birth || !supervisor?.birth || owner.pid !== health.process.pid || status?.childPid !== owner.pid
    || supervisor.pid !== status.supervisorPid || supervisor.supervisorRunId !== status.runId || owner.supervisorRunId !== status.runId || health.process.supervisorRunId !== status.runId
    || owner.generation !== status.generation || health.process.generation !== owner.generation) return false;
  return processAlive(owner.pid) && processBirth(owner.pid) === owner.birth && processAlive(supervisor.pid) && processBirth(supervisor.pid) === supervisor.birth;
}
function persistedStopResult(stateFile, row) {
  const receipt = readJSON(`${maintenancePaths(stateFile).directory}/daemon-stop-receipt.json`);
  if (receipt?.schemaVersion !== 1 || receipt.maintenanceOperationId !== row.id || receipt.cleanupComplete !== true || receipt.supervisorRunId !== row.expected.process.supervisorRunId
    || !Number.isFinite(Date.parse(receipt.at)) || Date.parse(receipt.at) < Date.parse(row.startedAt)) throw maintenanceFailure('旧服务停止回执尚未确认，请保留现场继续核查。', 'maintenance_stop_receipt_unconfirmed');
  return { stoppedDaemon: receipt.stoppedDaemon, lastDaemonExit: receipt.lastDaemonExit };
}
function startupReceipt(stateFile, operationId) {
  const path = `${maintenancePaths(stateFile).directory}/service-start-receipt.json`;
  try {
    const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 65536) return undefined;
    const receipt = readJSON(path); return receipt?.maintenanceOperationId === operationId ? publicStartupReceipt(receipt) : undefined;
  } catch { return undefined; }
}
/** Every transition is durable before its effect. A replacement worker resumes
 * from receipts; it never interprets disappearance or timeout as success. */
export async function runMaintenanceOperation({ stateFile, id, io = {} }) {
  stateFile = resolve(stateFile);
  if (!maintenanceId(id)) throw maintenanceFailure('维护身份无效。');
  ensureMaintenancePaths(stateFile, { create: true });
  const paths = maintenancePaths(stateFile), unlock = await acquireProcessLease(paths.worker, { operationId: id });
  const getHealth = io.health ?? healthAt, command = io.service ?? serviceCommand, sleep = io.sleep ?? delay;
  const runtimeIdentity = io.runtimeIdentity ?? runtimeImplementationIdentity, binding = io.binding ?? maintenanceProcessBound;
  const createCheckpoint = io.createCheckpoint ?? createStateCheckpoint, verifyCheckpoint = io.verifyCheckpoint ?? verifyStateCheckpoint, restoreCheckpoint = io.restoreCheckpoint ?? restoreStateCheckpointOriginal;
  const now = io.now ?? (() => performance.now()), waitMs = io.waitMs ?? 30 * 60000, verifyMs = io.verifyMs ?? 90000;
  // The CLI's lost/late receipt is not a reason to issue start again. This
  // separate, bounded window only observes the already attempted successor.
  const reconcileMs = Math.max(0, Math.min(60000, io.reconcileMs ?? 15000));
  let row, attemptId, attemptStart, stageStart, activeStage;
  const patch = async changes => {
    const final = attemptId && ['completed', 'cancelled', 'failed', 'recovery_required'].includes(changes.phase);
    row = await changeMaintenance(stateFile, id, value => ({ ...value, ...changes, ...(final ? {
      attempts: value.attempts.map(attempt => attempt.id !== attemptId ? attempt : { ...attempt,
        status: changes.phase === 'completed' ? 'completed' : changes.phase === 'cancelled' ? 'cancelled' : 'failed', elapsedMs: boundedElapsed(now() - attemptStart),
        stages: attempt.stages.map((stage, index) => activeStage && index === attempt.stages.length - 1 ? { ...stage, status: 'completed', elapsedMs: boundedElapsed(now() - stageStart) } : stage),
      }),
    } : {}) }));
    if (final) activeStage = null;
    return row;
  };
  const phase = value => patch({ phase: value, summary: summaries[value], errorCode: undefined });
  const updateAttempt = async change => {
    row = await changeMaintenance(stateFile, id, value => ({ ...value, attempts: value.attempts.map(attempt => attempt.id === attemptId ? change(attempt) : attempt) }));
  };
  const finishStage = async (status = 'completed', extra = {}) => {
    if (!activeStage) return;
    await updateAttempt(attempt => ({ ...attempt, stages: attempt.stages.map((stage, index) => index === attempt.stages.length - 1 ? { ...stage, status, elapsedMs: boundedElapsed(now() - stageStart), ...extra } : stage) }));
    activeStage = null;
  };
  const stage = async name => {
    await finishStage(); activeStage = name; stageStart = now();
    await updateAttempt(attempt => ({ ...attempt, stages: [...attempt.stages, { name, status: 'running', startedAt: stamp() }].slice(-MAINTENANCE_STAGE_LIMIT) }));
  };
  const perform = async () => { try {
    row = readMaintenance(stateFile);
    if (row?.id !== id || maintenanceTerminal(row.phase)) return row;
    if (row.restoreCompleted && row.verifiedProcess && row.phase === 'recovery_required') return row;
    attemptId = randomUUID(); attemptStart = now();
    await patch({ attemptCount: (Number.isSafeInteger(row.attemptCount) ? row.attemptCount : 0) + 1,
      attempts: [...(row.attempts ?? []).map(attempt => attempt.status === 'running' ? { ...attempt, status: 'interrupted', stages: attempt.stages.map(stage => stage.status === 'running' ? { ...stage, status: 'unconfirmed' } : stage) } : attempt),
        { id: attemptId, number: (row.attemptCount ?? 0) + 1, status: 'running', startedAt: stamp(), stages: [] }].slice(-MAINTENANCE_ATTEMPT_LIMIT) });
    await patch({ owner: { pid: process.pid, birth: processBirth(process.pid) } });
    if (row.kind === 'prepare') {
      await stage('prepare');
      const directory = resolve(paths.releases, id); mkdirSync(paths.releases, { recursive: true, mode: 0o700 });
      const release = existsSync(directory) ? verifyPreparedRuntime({ directory }) : prepareLocalRuntime({ source: row.args.source, destination: directory });
      const candidate = { id, digest: release.digest, hostVersion: release.manifest.hostVersion, sdkVersion: release.manifest.sdkVersion, trust: release.trust, baselineOnly: release.baselineOnly, preparedAt: row.startedAt };
      await registerMaintenanceEntry(stateFile, 'candidates', candidate);
      return await patch({ candidateId: id, held: false, phase: 'completed', completedAt: stamp(), summary: release.baselineOnly ? '运行包已完整核对；旧包缺少兼容性协议，只能保留作基线。' : '运行包已完整核对，可选择更新。' });
    }
    await stage('validate_runtime');
    // Resumed after the stop stage (e.g. an operator override of a held
    // operation): this attempt never ran the pre-stop native check.
    const resumedStopped = row.stopped === true;
    let target = row.expected.config, targetIdentity = row.expected.runtimeIdentity;
    if (!row.stopped && runtimeIdentity({ root: target.cwd, nodeVersion: row.expected.nodeVersion ?? process.versions.node, platform: process.platform, arch: process.arch }) !== row.expected.runtimeIdentity) {
      throw maintenanceFailure('旧服务的代码路径已变化，未执行可能属于另一版本的控制命令。', 'maintenance_runtime_changed');
    }
    if (row.args.candidateId) {
      const candidate = maintenanceRegistry(stateFile).candidates.find(item => item.id === row.args.candidateId);
      if (!candidate) throw maintenanceFailure('候选版本已不可用。', 'maintenance_candidate_invalid');
      const release = verifyPreparedRuntime({ directory: resolve(paths.releases, candidate.id), expectedDigest: candidate.digest, policy: releasePolicy(candidate.digest, row.expected.stateVersion) });
      target = { ...target, command: release.paths.sharedNode ? ensureSharedNode(release) : release.paths.node, cwd: release.paths.host };
      targetIdentity = runtimeIdentity({ root: target.cwd, nodeVersion: release.manifest.nodeVersion, platform: release.manifest.platform, arch: release.manifest.arch });
      await patch({ target: { ...target, hostVersion: release.manifest.hostVersion, sdkVersion: release.manifest.sdkVersion, nodeVersion: release.manifest.nodeVersion, runtimeIdentity: targetIdentity, digest: release.digest } });
    } else if (runtimeIdentity({ root: target.cwd, nodeVersion: row.expected.nodeVersion ?? process.versions.node, platform: process.platform, arch: process.arch }) !== targetIdentity) {
      throw maintenanceFailure('当前运行版本的文件已变化，不能用未核对的路径重新启动服务。', 'maintenance_runtime_changed');
    }
    // The new native identity must be able to read its runtime and existing
    // state BEFORE question handoff, draining, or stopping the old daemon.
    // A terminal/desktop-parent access check is not the launchd context.
    // Already-stopped legacy operations cannot retroactively gain this proof.
    if (!row.stopped && row.args.candidateId && target.manager === 'native' && (io.platform ?? process.platform) === 'darwin') {
      if (row.cancelRequested && row.phase === 'waiting_idle') return await patch({ phase: 'cancelled', held: false, completedAt: stamp(), summary: '已取消维护等待，继续当前工作。' });
      await stage('native_preflight');
      await patch({ summary: '正在核对新运行时的原生读取能力；当前服务继续运行。' });
      const receipt = await (io.nativePreflight ?? nativeRuntimeReadPreflight)({ stateFile, target, candidateId: row.args.candidateId, candidateDigest: row.target.digest, operationId: row.id });
      if (receipt.applicable !== true || receipt.status !== 'passed' || receipt.cleanup !== 'completed') throw Object.assign(maintenanceFailure('新运行时读取预检未通过。', 'maintenance_native_probe_unconfirmed'), { nativePreflight: publicNativePreflight(receipt) });
      await finishStage('completed', { nativePreflight: publicNativePreflight(receipt) });
    }
    if (!row.stopped) {
      await stage('waiting_idle');
      const deadline = now() + waitMs;
      for (;;) {
        row = readMaintenance(stateFile);
        if (row.cancelRequested && row.phase === 'waiting_idle') return await patch({ phase: 'cancelled', held: false, completedAt: stamp(), summary: '已取消维护等待，继续当前工作。' });
        const health = await getHealth(row.expected.config.port);
        if (!health && ['stopping', 'recovery_required'].includes(row.phase)) {
          // A worker may die after the CLI has replaced supervisor status but
          // before stdout is recorded. Only its durable, operation-bound stop
          // receipt can close that gap. HTTP silence never proves shutdown.
          const result = persistedStopResult(stateFile, row);
          assertDrainReceipt(row, readJSON(`${paths.directory}/drain-receipt.json`), result);
          await patch({ stopped: true, phase: 'offline', stopResult: result }); break;
        }
        if (health && !originalProcess(health, row)) throw maintenanceFailure('服务身份发生变化，未停止未知服务。', 'maintenance_identity_changed');
        if (health && heldBy(health, row) && health.workload?.activeWork && row.phase === 'waiting_idle') {
          if (health.maintenance.questionHandoff === 1) {
            if (!row.questionHandoff?.requestId) await patch({ questionHandoff: { version: 1, requestId: `question-${row.id}`, capability: 'supported', phase: 'requested' } });
            // This is negotiation, never authority to treat a live tool as
            // idle. The next health read must still prove complete draining.
            try { await (io.suspendQuestions ?? suspendQuestions)(row.expected.config.port, { operationId: row.id, requestId: row.questionHandoff.requestId }); }
            catch { /* Original work remains active; timeout never forces it. */ }
          } else if (!row.questionHandoff) await patch({ questionHandoff: { version: 1, capability: 'unsupported', phase: 'waiting_legacy', reason: 'Old daemon has no canonical question handoff capability; ordinary waiting and explicit user controls remain available.' } });
        }
        if (health && heldBy(health, row) && !health.workload?.activeWork) {
          if (!await binding(stateFile, health, row.expected.config)) throw maintenanceFailure('当前服务拥有者无法核对，未停止任何进程。', 'maintenance_identity_changed');
          // Cancel and admission are serialized against this boundary.
          row = await changeMaintenance(stateFile, id, value => value.cancelRequested && value.phase === 'waiting_idle'
            ? { ...value, phase: 'cancelled', held: false, completedAt: stamp(), summary: '已取消维护等待。' }
            : { ...value, phase: 'draining', summary: summaries.draining });
          if (row.phase === 'cancelled') return row;
          await phase('stopping');
          await stage('stop');
          const result = await command(row.expected.config, 'stop', stateFile, id);
          await patch({ stopResult: result });
          assertDrainReceipt(row, readJSON(`${paths.directory}/drain-receipt.json`), result);
          await patch({ stopped: true, phase: 'offline', summary: summaries.offline }); break;
        }
        if (now() >= deadline) throw maintenanceFailure('现有工作未在维护等待窗口内结束；未强行停止工作。', 'maintenance_wait_timeout');
        await sleep(500);
      }
    }
    if (!row.checkpointCompleted) {
      await stage('checkpoint');
      await phase('checkpointing'); mkdirSync(paths.checkpoints, { recursive: true, mode: 0o700 });
      const directory = resolve(paths.checkpoints, row.checkpointId);
      const checkpoint = existsSync(directory) ? await verifyCheckpoint({ directory }) : await createCheckpoint({ stateFile, destination: directory, hostVersion: row.expected.hostVersion, sdkVersion: row.expected.sdkVersion,
        onProgress: async ({ phase: checkpointPhase }) => updateAttempt(attempt => ({ ...attempt, stages: attempt.stages.map((value, index) => index === attempt.stages.length - 1 ? { ...value, checkpointPhase } : value) })) });
      if (checkpoint.manifest.sourceStateFile !== realpathSync(stateFile)) throw maintenanceFailure('恢复点属于另一个状态目录。', 'maintenance_checkpoint_binding');
      await registerMaintenanceEntry(stateFile, 'checkpoints', { id: row.checkpointId, createdAt: checkpoint.manifest.createdAt, files: checkpoint.files, bytes: checkpoint.bytes, scope: 'local_application_state', verified: true, manifestHash: checkpoint.manifestHash });
      await patch({ checkpointCompleted: true });
    }
    if (row.kind === 'restore' && !row.restoreCompleted) {
      await stage('restore');
      const checkpoint = maintenanceRegistry(stateFile).checkpoints.find(item => item.id === row.args.checkpointId);
      if (!checkpoint) throw maintenanceFailure('恢复点不可用。', 'maintenance_checkpoint_invalid');
      const directory = resolve(paths.checkpoints, checkpoint.id), verified = await verifyCheckpoint({ directory });
      if (verified.manifestHash !== checkpoint.manifestHash) throw maintenanceFailure('恢复点内容已变化。', 'maintenance_checkpoint_changed');
      await restoreCheckpoint({ directory, stateFile });
      await patch({ restoreCompleted: true });
    }
    await phase('switching');
    await stage('validate_target');
    // Recheck the immutable slot immediately before executing its Node. The
    // user approved this exact local digest; no publisher signature is implied.
    if (row.target) verifyPreparedRuntime({ directory: resolve(paths.releases, row.args.candidateId), expectedDigest: row.target.digest, policy: releasePolicy(row.target.digest, row.expected.stateVersion) });
    let healthy = await getHealth(target.port);
    const version = row.target ?? row.expected;
    const successor = async health => Boolean(health && row.startAttempted && heldBy(health, row) && health.version === version.hostVersion && health.sdkVersion === version.sdkVersion
      && health.runtimeIdentity === targetIdentity && health.process?.instanceId !== row.expected.process.instanceId && await binding(stateFile, health, target));
    if (healthy && !await successor(healthy)) throw maintenanceFailure('维护端口出现未核对的服务，未跳过启动或接管它。', 'maintenance_identity_changed');
    let receiptUnconfirmed = row.startAttempted && !row.startResult;
    // The target's own launchd identity must be able to read its runtime and
    // state before it is started, or a missing macOS (TCC/Documents) grant
    // would hang the successor silently. The old service is already stopped,
    // so a failure leaves the operation held for review (recovery_required).
    if (!healthy && !row.startAttempted && resumedStopped && row.args.candidateId && target.manager === 'native' && (io.platform ?? process.platform) === 'darwin') {
      await stage('native_preflight_start');
      await patch({ summary: '正在核对新运行时的原生读取能力，然后再启动服务。' });
      const receipt = await (io.nativePreflight ?? nativeRuntimeReadPreflight)({ stateFile, target, candidateId: row.args.candidateId, candidateDigest: row.target.digest, operationId: row.id });
      if (receipt.applicable !== true || receipt.status !== 'passed' || receipt.cleanup !== 'completed') throw Object.assign(maintenanceFailure('新运行时读取预检未通过。', 'maintenance_native_probe_unconfirmed'), { nativePreflight: publicNativePreflight(receipt) });
      await finishStage('completed', { nativePreflight: publicNativePreflight(receipt) });
    }
    if (!healthy && !row.startAttempted) {
      await patch({ startAttempted: true });
      await stage('start');
      try {
        const startResult = await command(target, 'start', stateFile, id);
        await patch({ startResult });
        await finishStage('completed', { serviceStartup: startupReceipt(stateFile, id) });
      } catch (error) {
        receiptUnconfirmed = true;
        await finishStage('unconfirmed', { failureType: maintenanceFailureType(error), serviceStartup: startupReceipt(stateFile, id) });
      }
    }
    await phase('verifying');
    await stage('verify_successor');
    const deadline = now() + (receiptUnconfirmed ? reconcileMs : verifyMs);
    for (;;) {
      healthy = await getHealth(target.port, { timeoutMs: Math.max(1, Math.min(5000, Math.ceil(deadline - now()))) });
      if (healthy && !await successor(healthy)) throw maintenanceFailure('启动后的服务身份不匹配。', 'maintenance_identity_changed');
      if (healthy && !healthy.persistence?.failed && (healthy.ok || serviceReady(healthy) || row.restoreCompleted)) break;
      if (now() >= deadline) throw maintenanceFailure('新服务未通过就绪验证，自动执行仍暂停。', receiptUnconfirmed ? 'maintenance_start_unconfirmed' : 'maintenance_verification_failed');
      await sleep(Math.max(1, Math.min(500, deadline - now())));
    }
    const supervisorStatus = readJSON(`${paths.directory}/status.json`);
    await finishStage('completed', { ...(receiptUnconfirmed ? { reconciled: true } : {}),
      ...(supervisorStatus?.childPid === healthy.process.pid && supervisorStatus.runId === healthy.process.supervisorRunId ? { supervisorStartup: publicStartupReceipt(supervisorStatus.startup) } : {}) });
    if (row.restoreCompleted) return await patch({ phase: 'recovery_required', held: true, errorCode: 'restored_state_review', summary: '恢复点已还原；自动执行保持暂停。请核对恢复点之后的交付、任务与远端记忆，再使用 rna recovery 核查。', verifiedProcess: healthy.process });
    return await patch({ phase: 'completed', held: false, completedAt: stamp(), summary: row.kind === 'backup' ? '恢复点已验证，服务已恢复。' : '应用版本已切换，身份与就绪检查通过。', verifiedProcess: healthy.process });
  } catch (error) {
    await finishStage('failed', { failureType: maintenanceFailureType(error), ...(publicCheckpointDiagnostic(error.checkpointDiagnostic) ? { checkpoint: publicCheckpointDiagnostic(error.checkpointDiagnostic) } : {}),
      ...(publicNativePreflight(error.nativePreflight) ? { nativePreflight: publicNativePreflight(error.nativePreflight) } : {}) });
    const current = readMaintenance(stateFile);
    if (current?.id === id && !maintenanceTerminal(current.phase)) {
      const unsafe = current.stopped || current.startAttempted || ['draining', 'stopping', 'offline', 'checkpointing', 'switching', 'verifying', 'recovery_required'].includes(current.phase);
      const preflightSummary = error.code === 'maintenance_native_access_denied'
        ? '新运行时读取被系统拒绝，等待确认访问权限；当前服务继续运行，现有工作未被停止。'
        : /^maintenance_native_/.test(error.code ?? '') ? '尚不能核对新运行时的原生读取能力；当前服务继续运行，现有工作未被停止。' : null;
      await patch({ phase: unsafe ? 'recovery_required' : 'failed', held: Boolean(unsafe), errorCode: /^[A-Za-z0-9_]{1,80}$/.test(error.code ?? '') ? error.code : 'maintenance_operation_failed', summary: unsafe ? error.code === 'maintenance_native_access_denied' ? '新运行时读取被系统拒绝（请确认 macOS 文稿等访问权限）；原服务已停止，自动执行保持暂停，授权后可接续。' : /^maintenance_native_/.test(error.code ?? '') ? '尚不能核对新运行时的原生读取能力，未启动新服务；自动执行保持暂停，可核查后接续。' : '维护尚未完成，自动执行保持暂停；可核查记录后接续。' : preflightSummary ?? '维护未完成，现有工作未被停止。', ...(unsafe ? {} : { completedAt: stamp() }) });
    }
    return readMaintenance(stateFile);
  } };
  try { await perform(); } finally {
    try {
      if (attemptId) {
        await finishStage();
        const final = readMaintenance(stateFile);
        if (final?.id === id && final.attempts?.find(attempt => attempt.id === attemptId)?.status === 'running') await updateAttempt(attempt => ({ ...attempt, status: final.phase === 'completed' ? 'completed' : final.phase === 'cancelled' ? 'cancelled' : 'failed', elapsedMs: boundedElapsed(now() - attemptStart) }));
      }
    } finally { unlock(); }
  }
  // Retention is best-effort housekeeping after a successful switch/backup;
  // a failure leaves extra copies for `maintenance prune`, never less state.
  try { const final = readMaintenance(stateFile); if (final?.id === id && final.phase === 'completed' && ['backup', 'apply', 'rollback'].includes(final.kind) && io.retention !== false) await applyRetention(stateFile); } catch { /* retried by the next operation or prune */ }
  return row;
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  try { await runMaintenanceOperation({ stateFile: process.argv[2], id: process.argv[3] }); }
  catch { process.exitCode = 1; }
}
