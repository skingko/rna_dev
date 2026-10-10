#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { unlinkSync, realpathSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { atomicWrite, readJSON } from './durable-files.mjs';
import { DaemonSupervisor, servicePaths } from './daemon-supervisor.mjs';
import { createEnduranceRun } from './endurance-monitor.mjs';
import { ManagedHelpers } from './managed-helpers.mjs';
import { acquireProcessLease, processAlive, processBirth } from './process-lease.mjs';
import { readMaintenance, maintenanceOwnerAlive, maintenanceFailure, ensureMaintenancePaths } from './application-maintenance-state.mjs';
import { assertStateRecoveryReady } from './state-checkpoint.mjs';
import { boundedElapsed, maintenanceFailureType } from './maintenance-diagnostics.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const execute = promisify(execFile);
const xml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
const quoteSystemd = value => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
export const serviceLabel = stateFile => `local.rna-agent.${createHash('sha256').update(stateFile).digest('hex').slice(0, 12)}`;
const helperFingerprints = pool => pool.status().helpers.map(({ id, descriptorPath, fingerprint }) => ({ id, descriptorPath, fingerprint }));
function currentSupervisor(paths, status) {
  const owner = readJSON(`${paths.directory}/supervisor.lock`);
  return Boolean(owner?.birth && owner.pid === status?.supervisorPid && processAlive(owner.pid) && processBirth(owner.pid) === owner.birth && (!owner.supervisorRunId || owner.supervisorRunId === status.runId));
}

export function serviceOptions(action, args, installed = {}) {
  let mode, descriptors, clearHelpers = false;
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (!['start', 'restart', 'install', 'run'].includes(action)) throw new Error('此服务命令不接受配置选项。');
    if (argument === '--session' || argument === '--native') {
      if (!['start', 'restart'].includes(action) || mode) throw new Error('start|restart 只能选择一次 --session 或 --native。');
      mode = argument.slice(2);
    } else if (argument === '--helper-descriptor') {
      const path = args[++i];
      if (!path || path.startsWith('--') || clearHelpers) throw new Error('--helper-descriptor 要求一个描述文件路径，且不能与 --without-helpers 并用。');
      (descriptors ??= []).push(realpathSync(resolve(path)));
    } else if (argument === '--without-helpers') {
      if (descriptors || clearHelpers) throw new Error('--without-helpers 不能重复或与 --helper-descriptor 并用。');
      clearHelpers = true;
    } else throw new Error(`未知服务选项：${argument}`);
  }
  const helpers = clearHelpers ? [] : descriptors ? [...new Set(descriptors)] : [...(installed.helperDescriptors ?? [])];
  // A stale status does not prove that old helper children exited with their
  // supervisor. Only restart owns the old-descriptor cleanup transaction.
  if (installed.stateFile && ['start', 'install', 'run'].includes(action) && JSON.stringify(helpers) !== JSON.stringify(installed.helperDescriptors ?? [])) throw new Error('修改受管依赖列表需要 service restart，以先回收旧配置拥有的进程。');
  return { manager: action === 'run' ? 'foreground' : mode ?? (['session', 'foreground'].includes(installed.manager) ? 'session' : 'native'), helperDescriptors: helpers };
}

export function launchAgentPlist(config, label = serviceLabel(config.stateFile)) {
  // KeepAlive on unsuccessful exit; intentional stop exits zero and also writes
  // an intent marker. No global power or privileged daemon configuration.
  // This process serves foreground desktop/CLI requests over HTTP. Background
  // throttles CPU and I/O; Adaptive only promotes activity over XPC, which this
  // service does not use. launchd.plist(5) assigns app-critical HTTP work the
  // Interactive class. This is not a request for realtime or display wake.
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(resolve(root, 'daemon-supervisor.mjs'))}</string><string>${xml(servicePaths(config.stateFile).config)}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(`${dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer><key>ExitTimeOut</key><integer>30</integer>
<key>ProcessType</key><string>Interactive</string><key>Umask</key><integer>63</integer>
</dict></plist>\n`;
}
export function systemdUnit(config) {
  return `[Unit]\nDescription=Rna Agent managed autonomy service\nStartLimitIntervalSec=900\nStartLimitBurst=5\n\n[Service]\nType=simple\nWorkingDirectory=${quoteSystemd(root)}\nExecStart=${[process.execPath, resolve(root, 'daemon-supervisor.mjs'), servicePaths(config.stateFile).config].map(quoteSystemd).join(' ')}\nRestart=on-failure\nRestartSec=30\nTimeoutStopSec=30\nKillMode=control-group\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}

async function command(program, args, optional = false) {
  try { return await execute(program, args, { timeout: 35000, maxBuffer: 128 * 1024 }); }
  catch (error) { if (optional) return null; throw new Error(`${program} ${args[0]} 失败：${String(error.stderr ?? error.message).trim().slice(0, 500)}`); }
}
async function manager(config) {
  const label = serviceLabel(config.stateFile);
  if (['session', 'foreground'].includes(config.manager)) {
    const paths = servicePaths(config.stateFile);
    return { path: null, label, domain: 'login-session', install: async () => {},
      start: async () => {
        const owner = readJSON(`${paths.directory}/supervisor.lock`);
        if (owner?.birth && processAlive(owner.pid) && processBirth(owner.pid) === owner.birth) return;
        const child = spawn(process.execPath, [resolve(root, 'daemon-supervisor.mjs'), paths.config], { cwd: root, env: process.env, detached: true, stdio: 'ignore' });
        await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); }); child.unref();
      },
      stop: async () => {
        const owner = readJSON(`${paths.directory}/supervisor.lock`);
        if (!owner || !processAlive(owner.pid)) return;
        if (!owner.birth || processBirth(owner.pid) !== owner.birth) throw new Error('无法验证当前监督进程身份，已保留现有进程。');
        const owned = () => processAlive(owner.pid) && processBirth(owner.pid) === owner.birth;
        if (owned()) process.kill(owner.pid, 'SIGTERM');
        const deadline = Date.now() + 25000;
        while (owned() && Date.now() < deadline) await new Promise(done => setTimeout(done, 100));
        if (owned()) process.kill(owner.pid, 'SIGKILL');
      }
    };
  }
  if (process.platform === 'darwin') {
    const domain = await command('/bin/launchctl', ['print-disabled', `gui/${process.getuid()}`], true) ? `gui/${process.getuid()}` : `user/${process.getuid()}`;
    const path = resolve(homedir(), 'Library/LaunchAgents', `${label}.plist`), target = `${domain}/${label}`;
    return { path, label, domain,
      install: async () => { atomicWrite(path, launchAgentPlist(config)); },
      start: async () => {
        await command('/bin/launchctl', ['enable', target]);
        if (!await command('/bin/launchctl', ['print', target], true)) await command('/bin/launchctl', ['bootstrap', domain, path]);
        else await command('/bin/launchctl', ['kickstart', target]);
      },
      stop: async () => { if (await command('/bin/launchctl', ['print', target], true)) await command('/bin/launchctl', ['bootout', target]); }
    };
  }
  if (process.platform === 'linux') {
    const unit = `${label}.service`, path = resolve(homedir(), '.config/systemd/user', unit);
    return { path, label, domain: 'systemd --user',
      install: async () => { atomicWrite(path, systemdUnit(config)); await command('systemctl', ['--user', 'daemon-reload']); },
      start: async () => { await command('systemctl', ['--user', 'enable', '--now', unit]); },
      stop: async () => { await command('systemctl', ['--user', 'disable', '--now', unit]); }
    };
  }
  throw new Error('原生服务安装目前支持 macOS LaunchAgent 与 Linux systemd --user；可使用 service run 前台运行。');
}

async function waitStatus(paths, predicate, timeoutMs = 35000) {
  const deadline = Date.now() + timeoutMs;
  let status;
  while (Date.now() < deadline) {
    status = readJSON(paths.status);
    if (predicate(status)) return status;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw maintenanceFailure(`服务未在期限内就绪，当前状态 ${status?.phase ?? 'unknown'}；运行 ./rna service status 查看详情。`, 'maintenance_start_receipt_timeout');
}

function startupRecorder(stateFile) {
  const started = performance.now(), receipt = { schemaVersion: 1, id: randomUUID(), maintenanceOperationId: /^[a-f0-9-]{36}$/.test(process.env.RNA_MAINTENANCE_OPERATION ?? '') ? process.env.RNA_MAINTENANCE_OPERATION : null, startedAt: new Date().toISOString(), status: 'running', stages: [] };
  let stageStarted;
  const save = () => atomicWrite(`${servicePaths(stateFile).directory}/service-start-receipt.json`, JSON.stringify(receipt));
  const finishStage = (status, error) => { const current = receipt.stages.at(-1); if (current?.status === 'running') Object.assign(current, { status, elapsedMs: boundedElapsed(performance.now() - stageStarted), ...(error ? { failureType: maintenanceFailureType(error) } : {}) }); };
  return {
    stage(name) { finishStage('completed'); stageStarted = performance.now(); receipt.stages.push({ name, status: 'running', startedAt: new Date().toISOString() }); save(); },
    finish(error) { finishStage(error ? 'failed' : 'completed', error); Object.assign(receipt, { status: error ? 'unconfirmed' : 'completed', elapsedMs: boundedElapsed(performance.now() - started) }); save(); },
  };
}

async function waitEndurance(paths, predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const report = readJSON(paths.endurance);
    if (predicate(report)) return report;
    await new Promise(done => setTimeout(done, 200));
  }
  throw new Error('观测控制请求已保存，但后台尚未确认；请查看 service status 与 endurance status，不要把请求已提交视为已完成。');
}

export async function runServiceCli(values) {
  const [topic = 'service', action = 'status'] = values;
  if (action === 'status') return executeServiceCli(values);
  const stateFile = resolve(process.env.RNA_AGENT_STATE ?? process.env.PI_FORGE_STATE ?? resolve(root, '.state/state.json'));
  ensureMaintenancePaths(stateFile, { create: true });
  const release = await acquireProcessLease(`${servicePaths(stateFile).directory}/operation.lock`);
  const context = {};
  try { const result = await executeServiceCli(values, release, context); context.startup?.finish(); return result; }
  catch (error) { context.startup?.finish(error); throw error; }
  finally { release(); }
}
async function executeServiceCli(values, releaseStartup = () => {}, context = {}) {
  const [topic = 'service', action = 'status', ...args] = values;
  const stateFile = resolve(process.env.RNA_AGENT_STATE ?? process.env.PI_FORGE_STATE ?? resolve(root, '.state/state.json'));
  ensureMaintenancePaths(stateFile, { create: action !== 'status' });
  // All mutation callers already own operation.lock. Checking before acquiring
  // it would permit a second CLI to change the service during a cutover.
  if (action !== 'status') {
    const maintenance = readMaintenance(stateFile);
    if (maintenance?.held && (process.env.RNA_MAINTENANCE_OPERATION !== maintenance.id || !maintenanceOwnerAlive(maintenance))) throw maintenanceFailure('应用维护期间服务控制由当前维护操作持有，请查看维护状态或恢复该操作。', 'maintenance_control_held');
  }
  const port = Number(process.env.RNA_AGENT_PORT ?? process.env.PI_FORGE_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('RNA_AGENT_PORT 必须为 1024–65535');
  const paths = servicePaths(stateFile);
  const installed = readJSON(paths.config);
  const options = topic === 'service' ? serviceOptions(action, args, installed ?? {}) : serviceOptions('status', [], installed ?? {});
  const config = { ...installed, schemaVersion: 1, stateFile, port, command: process.execPath, cwd: root, ...options };
  if (topic === 'service' && ['start', 'restart'].includes(action)) {
    context.startup = startupRecorder(stateFile); context.startup.stage('recovery_barrier');
  }
  if (topic === 'service' && ['install', 'start', 'restart', 'run'].includes(action)) {
    await assertStateRecoveryReady(stateFile);
    context.startup?.stage('configuration');
    config.helperFingerprints = helperFingerprints(new ManagedHelpers({ descriptors: config.helperDescriptors }));
    if (action !== 'restart' && installed?.helperFingerprints && JSON.stringify(installed.helperFingerprints) !== JSON.stringify(config.helperFingerprints)) throw new Error('受管依赖描述内容已变化，请使用 service restart 先回收旧配置。');
  }
  if (topic === 'endurance') {
    if (action === 'status') return readJSON(paths.endurance) ?? { status: 'not_started' };
    if (action === 'stop') {
      const run = readJSON(paths.endurance);
      if (run?.status !== 'running') return run ?? { status: 'not_started' };
      const requestId = randomUUID();
      atomicWrite(`${paths.directory}/endurance-request.json`, JSON.stringify({ requestId, action: 'stop', runId: run.id }));
      return waitEndurance(paths, report => report?.lastRequestId === requestId);
    }
    if (action !== 'start') throw new Error('用法：endurance start [--hours 小时] [--keep-awake] | status | stop；省略时长则按历史选择观测阶段');
    let hours, keepAwake = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--hours') hours = Number(args[++i]);
      else if (args[i] === '--keep-awake') keepAwake = true;
      else throw new Error(`未知耐久观测选项：${args[i]}`);
    }
    const old = readJSON(paths.endurance);
    if (old?.status === 'running') throw new Error('已有耐久观测运行中；请查看 status，或显式 stop 后开启新的记录。');
    const status = readJSON(paths.status);
    if (readJSON(paths.intent)?.enabled !== true || !status || Date.now() - Date.parse(status.updatedAt) > 20000 || !['running', 'degraded'].includes(status.phase)) throw new Error('请先运行 ./rna service start，等待后台服务就绪后再开始观测；已知降级会如实计入失败样本。');
    const history = readdirSync(paths.directory, { withFileTypes: true }).filter(row => row.isFile() && /^endurance-[A-Za-z0-9._-]+\.json$/.test(row.name) && row.name !== 'endurance-request.json')
      .flatMap(row => { try { const path = resolve(paths.directory, row.name), info = lstatSync(path); return info.isFile() && info.size <= 1024 * 1024 ? [{ path, modified: info.mtimeMs }] : []; } catch { return []; } })
      .sort((a, b) => b.modified - a.modified).slice(0, 255).map(row => readJSON(row.path)).filter(row => row?.id && [1, 2].includes(row.schemaVersion));
    const previousRuns = [...history, ...(old ? [old] : [])].sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt))).slice(-256);
    const run = createEnduranceRun({ id: randomUUID(), hours, keepAwake, previousRuns, runtimeIdentity: status.health?.runtimeIdentity ?? null });
    const requestId = randomUUID();
    atomicWrite(`${paths.directory}/endurance-request.json`, JSON.stringify({ requestId, action: 'start', run }));
    const started = await waitEndurance(paths, report => report?.lastRequestId === requestId);
    if (started.lastRequest?.status !== 'applied') throw new Error(`后台未开始新观测：${started.lastRequest?.reason ?? started.status}`);
    return { ...started, note: `开始记录实际墙钟运行；尚未通过目标时长。${started.lastSample?.healthy === false ? '当前降级已记为失败样本，不能将本轮宣称为全程健康验收。' : ''}不会为了凑时长或请求数自动制造模型任务。`, report: paths.endurance };
  }
  if (action === 'status') {
    const status = readJSON(paths.status);
    return { intent: readJSON(paths.intent), ...(status ?? { phase: 'not_installed' }),
      stale: !status?.updatedAt || Date.now() - Date.parse(status.updatedAt) > 20000,
      endurance: readJSON(paths.endurance), files: paths };
  }
  if (action === 'run') {
    if (installed && (installed.manager ?? 'native') === 'native') { const previous = await manager(installed); if (previous.path && existsSync(previous.path)) throw new Error('已有原生服务定义；请先 service uninstall，或用 service restart --session 切换后台模式。'); }
    const supervisor = new DaemonSupervisor(config);
    const lease = await acquireProcessLease(`${paths.directory}/supervisor.lock`, { supervisorRunId: supervisor.runId });
    try { atomicWrite(paths.config, JSON.stringify(config, null, 2)); atomicWrite(paths.intent, JSON.stringify({ enabled: true, updatedAt: new Date().toISOString() })); } catch (error) { lease(); throw error; }
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void supervisor.stop(); });
    await supervisor.start({ lease }); releaseStartup(); process.exitCode = await supervisor.exitPromise; return;
  }
  if (!['install', 'start', 'stop', 'restart', 'uninstall'].includes(action)) throw new Error('用法：service install|start|stop|restart|status|uninstall|run');
  const existing = readJSON(paths.status);
  if (['start', 'install'].includes(action) && installed && (installed.manager ?? 'native') !== config.manager) throw new Error('切换托管方式需要 service restart --session 或 service restart --native，以先清理旧管理器。');
  if (['start', 'install'].includes(action) && existing && currentSupervisor(paths, existing) && installed && (installed.port !== port || installed.command !== process.execPath || (installed.manager ?? 'native') !== config.manager || JSON.stringify(installed.helperDescriptors ?? []) !== JSON.stringify(config.helperDescriptors))) throw new Error('运行中的服务配置不同，请使用 service restart 应用端口、Node 路径或依赖托管修改。');
  const native = await manager(config);
  let stoppedDaemon = null, lastDaemonExit = null;
  if (['stop', 'restart', 'uninstall'].includes(action)) {
    const stoppingStatus = readJSON(paths.status);
    if (Number.isSafeInteger(stoppingStatus?.childPid) && stoppingStatus.childPid > 0 && typeof stoppingStatus.generation === 'string') stoppedDaemon = { pid: stoppingStatus.childPid, generation: stoppingStatus.generation };
    atomicWrite(paths.intent, JSON.stringify({ enabled: false, updatedAt: new Date().toISOString() }));
    const previousManager = await manager(installed ?? config);
    await previousManager.stop();
    // Native manager stop may return before children finish their drain.
    const status = readJSON(paths.status);
    if (status && status.phase !== 'stopped' && processAlive(status.supervisorPid) && Date.now() - Date.parse(status.updatedAt) < 35000) await waitStatus(paths, value => value?.phase === 'stopped').catch(() => {});
    // The cleanup supervisor below writes its own stopped status. Capture only
    // this daemon's pinned generation, never a historical exit or cleanup PID.
    const stoppedStatus = readJSON(paths.status), receipt = stoppedStatus?.lastDaemonExit;
    if (stoppedDaemon && stoppedStatus?.runId === stoppingStatus.runId && receipt?.pid === stoppedDaemon.pid && receipt.generation === stoppedDaemon.generation
      && (receipt.code === null || Number.isInteger(receipt.code)) && (receipt.signal === null || typeof receipt.signal === 'string') && Number.isFinite(Date.parse(receipt.at))) lastDaemonExit = { pid: receipt.pid, generation: receipt.generation, code: receipt.code, signal: receipt.signal, at: receipt.at };
    const cleanup = new DaemonSupervisor({ ...config, helperDescriptors: installed?.helperDescriptors ?? [], recoverOnStop: true, stopOnly: true }); await cleanup.start(); await cleanup.exitPromise;
    if (cleanup.exitCode) throw new Error('服务清理未完成；运行 service status 检查拥有者与恢复状态。');
    // The calling maintenance worker may crash before consuming stdout. Keep
    // the actual old-daemon exit independently of the cleanup status record.
    atomicWrite(`${paths.directory}/daemon-stop-receipt.json`, JSON.stringify({ schemaVersion: 1,
      maintenanceOperationId: process.env.RNA_MAINTENANCE_OPERATION ?? null,
      supervisorRunId: stoppingStatus?.runId ?? null, stoppedDaemon, lastDaemonExit,
      cleanupComplete: true, at: new Date().toISOString() }));
    if (action !== 'restart') {
      const run = readJSON(paths.endurance) ?? { status: 'not_started' }, requestId = randomUUID(), at = new Date().toISOString();
      // The supervisor has relinquished its lease. Invalidate any unconsumed
      // start command too, so a later service start cannot resurrect a stopped
      // observation. The CLI operation lease serializes other control writers.
      atomicWrite(`${paths.directory}/endurance-request.json`, JSON.stringify({ requestId, action: 'stop', runId: run.id ?? null }));
      if (run.status === 'running') { run.status = 'stopped'; run.stoppedAt = at; run.passed = null; }
      run.lastRequestId = requestId; run.lastRequest = { requestId, action: 'stop', status: 'applied', reason: 'service_stopped', at };
      atomicWrite(paths.endurance, JSON.stringify(run, null, 2));
    }
    if ((action === 'uninstall' || (installed?.manager ?? 'native') !== config.manager) && previousManager.path) { try { unlinkSync(previousManager.path); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    if (action !== 'restart') return { phase: 'stopped', uninstalled: action === 'uninstall', userDataPreserved: true, stoppedDaemon, lastDaemonExit };
  }
  atomicWrite(paths.config, JSON.stringify(config, null, 2));
  context.startup?.stage('manager_install');
  await native.install();
  if (action === 'install') return { installed: true, path: native.path, domain: native.domain, started: false };
  atomicWrite(paths.intent, JSON.stringify({ enabled: true, updatedAt: new Date().toISOString() }));
  context.startup?.stage('manager_start');
  await native.start();
  context.startup?.stage('wait_status');
  const status = await waitStatus(paths, value => ['running', 'degraded'].includes(value?.phase) && value.configuration?.port === port && value.configuration?.command === process.execPath && JSON.stringify(value.configuration?.helperFingerprints ?? []) === JSON.stringify(config.helperFingerprints) && Date.now() - Date.parse(value.updatedAt) < 10000 && currentSupervisor(paths, value));
  return { phase: status.phase, supervisorPid: status.supervisorPid, childPid: status.childPid, address: `http://127.0.0.1:${port}`, nativeService: native.path, management: config.manager, ...(action === 'restart' ? { stoppedDaemon, previousDaemonExit: lastDaemonExit } : {}), ...(config.manager === 'session' ? { limitation: '当前登录会话后台模式；daemon由supervisor恢复，但操作系统重启或supervisor自身退出后不自动恢复。' } : {}) };
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  try { const result = await runServiceCli(process.argv.slice(2)); if (result !== undefined) console.log(JSON.stringify(result, null, 2)); }
  catch (error) { console.error(`Rna Agent: ${error.message}`); process.exitCode = 1; }
}
