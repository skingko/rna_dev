import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const runtime = resolve(import.meta.dirname, '..'), host = join(runtime, 'prototypes/control-center');
const require = createRequire(import.meta.url), desktopModule = name => require(existsSync(join(runtime, 'desktop', name)) ? `../desktop/${name}` : `../../desktop/${name}`);
// Electron's appData, as desktop/main.cjs uses it: Application Support on macOS, %APPDATA% on Windows, the XDG config folder on Linux.
const appData = process.platform === 'darwin' ? join(homedir(), 'Library/Application Support') : process.platform === 'win32' ? process.env.APPDATA ?? join(homedir(), 'AppData/Roaming') : process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
const dataDir = resolve(process.env.RNA_DESKTOP_DATA ?? join(appData, 'Rna Agent'));
const executable = process.platform === 'win32' ? { node: 'bin/node.exe', cli: 'bin/rna.cmd' } : { node: 'bin/node', cli: 'bin/rna' };
const args = process.argv.slice(2), help = !args.length || ['help','-h','--help','--version','version-info'].includes(args[0]);
const offlineRecovery = args[0] === 'recovery' && ['status', 'resume', 'reconcile', 'restore'].includes(args[1]);
let stateFile = process.env.RNA_AGENT_STATE ? resolve(process.env.RNA_AGENT_STATE) : join(dataDir, 'state.json');
let connection;
try { connection = JSON.parse(readFileSync(join(dataDir, 'desktop-connection.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !offlineRecovery && !help) { console.error('Rna Agent: 无法读取桌面服务连接，请重新打开应用。'); process.exit(1); } }
if (!process.env.RNA_AGENT_STATE && typeof connection?.stateFile === 'string' && isAbsolute(connection.stateFile)) stateFile = connection.stateFile;
if (connection?.managed===false && !help && !offlineRecovery && !process.env.RNA_AGENT_PORT) {
  const {verifyService}=desktopModule('discovery.cjs');
  const verified=await verifyService(connection.serviceConfig,{host});
  if(!verified){console.error('Rna Agent: 原有服务身份已变化，请重新打开桌面应用以连接。');process.exit(1);}
  if (process.env.RNA_AGENT_STATE && verified.stateFile !== stateFile) { console.error('Rna Agent: 指定状态目录与桌面连接不一致，请同时指定该实例的 RNA_AGENT_PORT。'); process.exit(1); }
  connection=verified;stateFile=verified.stateFile;
  try {
    const config = JSON.parse(readFileSync(verified.serviceConfig, 'utf8'));
    if (typeof config.command === 'string' && config.command.startsWith(`${stateFile}.service/releases/`)) {
      const { resolveManagedRuntime, assertManagedHealth } = desktopModule('managed-runtime.cjs');
      const selected = await resolveManagedRuntime({ paths: { host, node: join(runtime,executable.node), bin: join(runtime,'bin'), cli: join(runtime,executable.cli) }, stateFile, config });
      const response = await fetch(`${verified.origin}/api/health`, { signal: AbortSignal.timeout(10000), redirect: 'error' }), health = await response.json();
      if (!response.ok || health.process?.pid !== verified.daemonPid || health.process?.instanceId !== verified.instanceId) throw Error('服务身份发生变化');
      assertManagedHealth(health, selected);
    }
  } catch (error) { console.error(`Rna Agent: ${error.message}；未连接未验证的运行版本。`); process.exit(1); }
}
if (!help && !offlineRecovery && !process.env.RNA_AGENT_PORT && (!connection || connection.stateFile !== stateFile || !Number.isInteger(connection.port) || connection.port < 1024 || connection.port > 65535)) { console.error('Rna Agent: 请先打开 Rna Agent.app；CLI 会连接相同项目和会话。'); process.exit(1); }
const env = { ...process.env, RNA_AGENT_STATE: stateFile, RNA_AGENT_PORT: process.env.RNA_AGENT_PORT ?? String(connection?.port ?? 4317), PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? process.env.Path ?? '/usr/bin:/bin'}` };
if (process.platform === 'win32') for (const name of Object.keys(env)) if (name !== 'PATH' && name.toUpperCase() === 'PATH') delete env[name]; delete env.PI_FORGE_STATE; delete env.PI_FORGE_PORT;
const service = ['service','endurance'].includes(args[0]);
let command = process.execPath, commandHost = host;
if (!offlineRecovery && !help && connection?.managed === true) {
  try {
    const config = JSON.parse(readFileSync(`${stateFile}.service/config.json`, 'utf8'));
    const { resolveManagedRuntime, assertManagedHealth } = desktopModule('managed-runtime.cjs');
    const selected = await resolveManagedRuntime({ paths: { host, node: join(runtime,executable.node), bin: join(runtime,'bin'), cli: join(runtime,executable.cli) }, stateFile, config });
    if (!service && !process.env.RNA_AGENT_PORT) {
      const { verifyService } = desktopModule('discovery.cjs'), verified = await verifyService(`${stateFile}.service/config.json`, { host });
      if (!verified) throw Error('无法核对当前服务身份，请重新打开桌面应用或使用 recovery status 查看');
      const response = await fetch(`${verified.origin}/api/health`, { signal: AbortSignal.timeout(10000), redirect: 'error' }), health = await response.json();
      if (!response.ok || health.process?.pid !== verified.daemonPid || health.process?.instanceId !== verified.instanceId) throw Error('服务身份发生变化');
      assertManagedHealth(health, selected);
    }
    if (service && selected.release) { command = selected.paths.node; commandHost = selected.paths.host; }
  } catch (error) { console.error(`Rna Agent: ${error.message}；未执行旧应用路径。`); process.exit(1); }
}
const child = spawn(command, [join(commandHost, offlineRecovery ? 'application-recovery-cli.mjs' : service ? 'service-cli.mjs' : 'cli.mjs'), ...args], { env, stdio: 'inherit' });
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(`Rna Agent: ${error.message}`); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
