import { resolve, isAbsolute, dirname, basename, join, relative, sep } from 'node:path';
import { realpathSync, openSync, closeSync, readSync, fstatSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { readJSON } from './durable-files.mjs';
import { acquireProcessLease, processBirth } from './process-lease.mjs';
import { ensureMaintenancePaths, readMaintenance, maintenanceTerminal, maintenanceOwnerAlive, withMaintenanceControl, persistMaintenance, initialMaintenance, changeMaintenance, publicMaintenanceOperation, maintenanceFailure } from './application-maintenance-state.mjs';
import { maintenanceId, maintenanceRegistry, startMaintenanceWorker } from './application-maintenance.mjs';
import { acquireCheckpointLease, verifyStateCheckpoint, restoreStateCheckpointOriginal } from './state-checkpoint.mjs';
import { applicationRecoveryStatus, reconcileRestoredState } from './application-recovery.mjs';
import { runtimeImplementationIdentity } from './runtime-identity.mjs';
import { releaseRunsNode, verifyPreparedRuntime } from './runtime-release.mjs';

const execute = promisify(execFile);
const help = 'rna recovery status | resume <操作ID> | reconcile <操作ID> --confirm | restore <恢复点ID> --confirm';
async function service(config, action, stateFile, id) {
  const env = { ...process.env, RNA_AGENT_STATE: stateFile, RNA_AGENT_PORT: String(config.port), RNA_MAINTENANCE_OPERATION: id };
  delete env.PI_FORGE_STATE; delete env.PI_FORGE_PORT;
  const result = await execute(config.command, [resolve(config.cwd, 'service-cli.mjs'), 'service', action, ...(action === 'start' ? [config.manager === 'native' ? '--native' : '--session'] : [])], { cwd: config.cwd, env, timeout: 90000, maxBuffer: 262144 });
  return JSON.parse(result.stdout);
}
function runtimeConfig(config, stateFile) {
  if (!config || !isAbsolute(config.command ?? '') || !isAbsolute(config.cwd ?? '') || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || !['native', 'session', 'foreground'].includes(config.manager ?? 'native')) throw maintenanceFailure('缺少可核对的应用运行配置。', 'recovery_runtime_unavailable');
  const canonical = value => { if (!isAbsolute(value ?? '')) return null; try { return join(realpathSync(dirname(value)), basename(value)); } catch { return null; } };
  if (!canonical(config.stateFile) || canonical(config.stateFile) !== canonical(stateFile)) throw maintenanceFailure('运行配置属于另一个状态目录。', 'recovery_runtime_binding');
  return config;
}
const normalizedNodeVersion = value => typeof value === 'string' ? value.replace(/^v/, '') : null;
function nodeDigest(path) {
  // Inspection never executes an unfamiliar binary, including --version.
  const fd = openSync(realpathSync(path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || !(before.mode & 0o111) || before.size < 1 || before.size > 512 * 1024 ** 2) throw maintenanceFailure('运行程序无法安全核对。', 'recovery_node_untrusted');
    const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024); let bytes = 0, count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null))) {
      bytes += count; if (bytes > before.size) throw maintenanceFailure('运行程序在核对时发生变化。', 'recovery_node_untrusted');
      digest.update(buffer.subarray(0, count));
    }
    const after = fstatSync(fd);
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw maintenanceFailure('运行程序在核对时发生变化。', 'recovery_node_untrusted');
    return digest.digest('hex');
  } finally { closeSync(fd); }
}
function checkedRuntimeConfig(config, stateFile, expected) {
  runtimeConfig(config, stateFile); runtimeConfig(expected?.config, stateFile);
  const canonical = path => realpathSync(path);
  if (canonical(config.command) !== canonical(expected.config.command) || canonical(config.cwd) !== canonical(expected.config.cwd) || config.port !== expected.config.port || (config.manager ?? 'native') !== (expected.config.manager ?? 'native')) throw maintenanceFailure('运行配置与维护时记录的版本不符。', 'recovery_runtime_binding');
  if (!/^[a-f0-9]{64}$/.test(expected.runtimeIdentity ?? '') || !normalizedNodeVersion(expected.nodeVersion)) throw maintenanceFailure('缺少可核对的应用运行身份。', 'recovery_runtime_unavailable');
  const paths = ensureMaintenancePaths(stateFile), releases = resolve(paths.releases);
  const command = canonical(config.command), cwd = canonical(config.cwd);
  const inSlots = path => { const tail = relative(releases, path); return tail === '' || tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail); };
  let nodeVersion = process.versions.node;
  if (inSlots(command) || inSlots(cwd)) {
    const slotId = relative(releases, cwd).split(sep)[0];
    const candidate = maintenanceRegistry(stateFile).candidates.find(value => value.id === slotId);
    if (!candidate || !/^[a-f0-9]{64}$/.test(candidate.digest ?? '')) throw maintenanceFailure('运行目录不是已登记的版本。', 'recovery_runtime_binding');
    const release = verifyPreparedRuntime({ directory: resolve(releases, candidate.id), expectedDigest: candidate.digest, policy: { allowedDigests: [candidate.digest], platform: process.platform, arch: process.arch, hostProtocolVersion: 1, stateVersion: expected.stateVersion, allowedWriteVersions: [2] } });
    if (!releaseRunsNode(release, command, canonical) || cwd !== canonical(release.paths.host) || expected.hostVersion !== release.manifest.hostVersion || expected.sdkVersion !== release.manifest.sdkVersion) throw maintenanceFailure('运行目录与已登记版本不符。', 'recovery_runtime_binding');
    nodeVersion = release.manifest.nodeVersion;
  } else if (command !== canonical(process.execPath) && nodeDigest(command) !== nodeDigest(process.execPath)) {
    throw maintenanceFailure('运行程序不是当前受信任的 Node 或已验证运行包。', 'recovery_node_untrusted');
  }
  if (normalizedNodeVersion(expected.nodeVersion) !== normalizedNodeVersion(nodeVersion) || runtimeImplementationIdentity({ root: cwd, nodeVersion, platform: process.platform, arch: process.arch }) !== expected.runtimeIdentity) throw maintenanceFailure('运行版本内容已变化，未执行控制命令。', 'recovery_runtime_changed');
  return config;
}
function checkedOperationRuntime(config, stateFile, row) {
  // A switched target is trusted only after the worker verified its successor;
  // its slot still undergoes a complete registered-manifest rehash above.
  const expected = row?.target && row.verifiedProcess && row.args?.candidateId
    ? { ...row.expected, ...row.target, config: row.target }
    : row?.expected;
  return checkedRuntimeConfig(config, stateFile, expected);
}
export async function runApplicationRecoveryCli(args, { stateFile = resolve(process.env.RNA_AGENT_STATE ?? process.env.PI_FORGE_STATE ?? resolve(import.meta.dirname, '.state/state.json')), io = {} } = {}) {
  const [topic, action = 'status', id, ...rest] = args;
  const flags = action === 'status' ? args.slice(2) : rest, allowed = ['restore', 'reconcile'].includes(action) ? ['--confirm', '--json'] : ['--json'];
  if (topic !== 'recovery' || !['status', 'resume', 'reconcile', 'restore'].includes(action) || (action !== 'status' && !maintenanceId(id)) || flags.some(value => !allowed.includes(value)) || new Set(flags).size !== flags.length) throw maintenanceFailure(help, 'recovery_input_invalid');
  stateFile = resolve(stateFile); const paths = ensureMaintenancePaths(stateFile);
  const runService = io.service ?? service, launch = io.launch ?? startMaintenanceWorker;
  if (action === 'status') {
    const row = readMaintenance(stateFile);
    let recovery;
    try { recovery = await applicationRecoveryStatus({ stateFile }); }
    catch (cause) { if (!['application_recovery_invalid', 'ENOENT'].includes(cause.code)) throw cause; recovery = { available: false, errorCode: cause.code, summary: '本机主状态不可读取；恢复点与维护记录仍可核查，可在停机后选择已验证恢复点。' }; }
    return { operation: publicMaintenanceOperation(row), held: row?.held ?? false, workerAlive: maintenanceOwnerAlive(row), checkpoints: maintenanceRegistry(stateFile).checkpoints,
      recovery,
      guidance: row?.restoreCompleted ? '已还原本机数据。核对项目文件与远端记忆后运行 recovery reconcile <操作ID> --confirm；旧会话保留为历史，旧工作不会自动重放。' : '中断维护可用 recovery resume <操作ID> 接续；状态恢复只覆盖本机应用数据，不回滚项目目录或远端记忆。' };
  }
  if (action === 'resume') {
    await withMaintenanceControl(stateFile, () => {
      const row = readMaintenance(stateFile);
      if (row?.id !== id || maintenanceTerminal(row.phase) || maintenanceOwnerAlive(row)) throw maintenanceFailure('没有可接续的中断维护。', 'maintenance_cannot_recover');
      if (row.restoreCompleted && row.verifiedProcess) throw maintenanceFailure('数据已还原，请先核查并运行 reconcile。', 'restored_state_review');
    });
    await launch({ stateFile, id }); return { accepted: true, operationId: id, completed: false, guidance: '已提交接续请求；运行 recovery status 查看最终结果。' };
  }
  if (!rest.includes('--confirm')) throw maintenanceFailure(action === 'restore' ? '还原会替换本机会话与配置，项目文件和远端记忆不回滚；请带 --confirm 确认具体恢复点。' : '核查后旧会话保留为历史，主动行为、任务和记忆写入保持暂停；请带 --confirm 确认。', 'recovery_confirmation_required');
  if (action === 'reconcile') {
    const unlock = await acquireProcessLease(paths.worker, { operationId: id });
    try {
      const row = readMaintenance(stateFile);
      const reconciled = row?.id === id && row.restoreCompleted && row.phase === 'completed' && !row.held;
      if (!reconciled) {
        if (row?.id !== id || !row.restoreCompleted || !row.held || maintenanceOwnerAlive(row)) throw maintenanceFailure('此操作不是待核查的数据恢复。', 'recovery_not_pending');
        const config = checkedOperationRuntime(readJSON(`${paths.directory}/config.json`), stateFile, row);
        await changeMaintenance(stateFile, id, value => ({ ...value, owner: { pid: process.pid, birth: processBirth(process.pid) } }));
        await runService(config, 'stop', stateFile, id);
      }
    } finally { unlock(); }
    const result = await reconcileRestoredState({ stateFile, operationId: id });
    await runService(checkedOperationRuntime(readJSON(`${paths.directory}/config.json`), stateFile, readMaintenance(stateFile)), 'start', stateFile, id);
    return { completed: true, operationId: id, recovery: result, guidance: '已核查并重新打开工作台。解除急停后请新开会话；旧会话、主动行为、任务和记忆写入仍需分别检查，未自动重放。' };
  }
  // Disaster restore is also usable while the HTTP host cannot start. It owns
  // the offline leases; it never kills an unverified/live host to force restore.
  const unlock = await acquireProcessLease(paths.worker, { purpose: 'offline-restore' });
  let operation, lease;
  try {
    const registry = maintenanceRegistry(stateFile), checkpoint = registry.checkpoints.find(row => row.id === id && row.verified);
    if (!checkpoint) throw maintenanceFailure('恢复点不存在。', 'maintenance_checkpoint_invalid');
    const directory = resolve(paths.checkpoints, id), verified = await verifyStateCheckpoint({ directory });
    if (verified.manifestHash !== checkpoint.manifestHash || verified.manifest.sourceStateFile !== paths.canonicalStateFile) throw maintenanceFailure('恢复点内容或目录绑定不符。', 'maintenance_checkpoint_binding');
    const config = readJSON(`${paths.directory}/config.json`), status = readJSON(`${paths.directory}/status.json`), oldHealth = status?.health;
    runtimeConfig(config, stateFile);
    if (typeof oldHealth?.runtimeIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(oldHealth.runtimeIdentity) || !oldHealth.process || typeof oldHealth.version !== 'string' || typeof oldHealth.sdkVersion !== 'string') throw maintenanceFailure('缺少可核对的应用运行身份。', 'recovery_runtime_unavailable');
    checkedRuntimeConfig(config, stateFile, { config, hostVersion: oldHealth.version, sdkVersion: oldHealth.sdkVersion, nodeVersion: oldHealth.node, runtimeIdentity: oldHealth.runtimeIdentity, stateVersion: 2 });
    // Prove offline ownership before publishing a held operation. A live
    // daemon therefore leaves the current maintenance/admission state alone.
    lease = await acquireCheckpointLease(stateFile);
    operation = await withMaintenanceControl(stateFile, () => {
      const row = readMaintenance(stateFile);
      if (row && !maintenanceTerminal(row.phase)) throw maintenanceFailure('已有待完成维护，请先核查其记录。', 'maintenance_busy');
      const next = initialMaintenance('restore', { checkpointId: id }, randomUUID(), { config, process: oldHealth.process, hostVersion: oldHealth.version, sdkVersion: oldHealth.sdkVersion, nodeVersion: oldHealth.node, stateVersion: 2, runtimeIdentity: oldHealth.runtimeIdentity });
      return persistMaintenance(stateFile, { ...next, stopped: true, checkpointCompleted: true, phase: 'offline', checkpointId: id, owner: { pid: process.pid, birth: processBirth(process.pid) } });
    });
    await restoreStateCheckpointOriginal({ directory, stateFile, lease });
    operation = await changeMaintenance(stateFile, operation.id, value => ({ ...value, restoreCompleted: true, owner: null }));
  } catch (error) {
    if (operation) await changeMaintenance(stateFile, operation.id, value => ({ ...value, phase: 'recovery_required', held: true, errorCode: /^[a-zA-Z0-9_]{1,80}$/.test(error.code ?? '') ? error.code : 'recovery_failed', owner: null, summary: '恢复尚未完成，原状态与恢复记录保留。' }));
    throw error;
  } finally { lease?.release(); unlock(); }
  await launch({ stateFile, id: operation.id });
  return { accepted: true, operationId: operation.id, completed: false, guidance: '恢复数据已落盘，服务将以暂停状态启动；运行 recovery status 核对结果。' };
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  try { console.log(JSON.stringify(await runApplicationRecoveryCli(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(JSON.stringify({ error: error.status ? error.message : '恢复操作未完成，请核对本机维护记录。', code: error.code ?? 'recovery_failed' })); process.exitCode = 1; }
}
