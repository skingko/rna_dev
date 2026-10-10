const { spawn } = require('node:child_process');
const { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync } = require('node:fs');
const { join, resolve, isAbsolute, delimiter } = require('node:path');
const net = require('node:net');
const { findExistingService } = require('./discovery.cjs');
const { readOwnedSupervisor, stopOwnedSupervisor } = require('./ownership.cjs');
const { verifyService } = require('./discovery.cjs');
const { resolveManagedRuntime, assertManagedHealth } = require('./managed-runtime.cjs');
const { setTimeout: delay } = require('node:timers/promises');
const readJSON = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
// The startup page and the startup-failure dialog follow the interface language main.cjs knows (the system locale until
// the service answers). `language` is a function or a value, read when a message is produced.
const TEXT = {
  zh: { timeout: '本机服务启动或关闭超时，请查看应用数据目录中的服务日志。', exited: code => `本机服务命令退出（${code}）`, unreadable: '本机服务返回了无法读取的启动结果。', missing: '安装包缺少 Node 或服务文件，请重新安装 Rna Agent。',
    externalWaiting: '原有工作台正在维护，等待重新连接同一实例…', externalHeld: '原有工作台仍在维护，未创建替代工作空间。使用 CLI recovery status 查看。', configMismatch: '应用数据目录中的服务配置不匹配，未启动或停止任何其他服务。',
    waiting: '应用维护中，正在等待本机服务重新连接…', maintenanceIdentity: '维护服务身份发生变化，未连接未知服务。', maintenanceHeld: '应用维护仍未恢复服务；当前记录和工作已保留。使用 CLI recovery status 查看，不会强行停止或重启。',
    serviceIdentity: '应用服务身份发生变化。', port: '应用服务端口无效。', receipt: '本机服务启动回执或监督器身份不匹配。', unverified: '无法核对本机服务身份，未打开应用页面。', externalIdentity: '原有工作台身份发生变化。' },
  en: { timeout: 'The local service took too long to start or stop. See the service log in the app data folder.', exited: code => `The local service command exited (${code}).`, unreadable: 'The local service returned a startup result that could not be read.', missing: 'The app is missing Node or its service files. Reinstall Rna Agent.',
    externalWaiting: 'The existing workspace is under maintenance; waiting to reconnect to the same instance…', externalHeld: 'The existing workspace is still under maintenance, so no replacement workspace was created. Run the CLI command recovery status to check.', configMismatch: 'The service settings in the app data folder do not match; no other service was started or stopped.',
    waiting: 'The app is under maintenance; waiting for the local service to reconnect…', maintenanceIdentity: 'The service changed during maintenance, so an unknown service was not connected.', maintenanceHeld: 'Maintenance has not brought the service back yet; your records and work are kept. Run the CLI command recovery status to check; nothing is stopped or restarted by force.',
    serviceIdentity: 'The app service changed identity.', port: 'The app service port is invalid.', receipt: 'The local service startup receipt or its supervisor does not match.', unverified: 'Could not verify the local service, so the app page was not opened.', externalIdentity: 'The existing workspace changed identity.' }
};
const languageOf = language => ((typeof language === 'function' ? language() : language) === 'en' ? 'en' : 'zh');
function runtimePaths({ packaged, appPath, desktopPath = __dirname, platform = process.platform }) {
  const runtime = packaged ? join(appPath, 'runtime') : null, windows = platform === 'win32';
  return { host: runtime ? join(runtime, 'prototypes/control-center') : resolve(desktopPath, '..'),
    node: runtime ? join(runtime, windows ? 'bin/node.exe' : 'bin/node') : resolve(desktopPath, '../.runtime/node/node_modules/node/bin/node'),
    bin: runtime ? join(runtime, 'bin') : resolve(desktopPath, '../.runtime/node/node_modules/node/bin'),
    cli: runtime ? join(runtime, windows ? 'bin/rna.cmd' : 'bin/rna') : resolve(desktopPath, '../rna') };
}
function reservePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); }); }); }
function execute(program, args, { language = 'zh', ...options } = {}) { const text = TEXT[languageOf(language)]; return new Promise((resolve, reject) => { const child = spawn(program, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(text.timeout)); }, 90000); child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-262144); }); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); }); child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error(stderr.trim() || text.exited(code))); else { try { resolve(stdout.trim() ? JSON.parse(stdout) : null); } catch { reject(new Error(text.unreadable)); } } }); }); }
class DesktopRuntime {
  constructor({ paths, dataDir, env = process.env, platform = process.platform, launch = spawn, run = execute, choosePort = reservePort, request = fetch, readOwner = readOwnedSupervisor, stopOwner = stopOwnedSupervisor, selectRuntime = resolveManagedRuntime, verifyConnection = verifyService, wait = delay, now = Date.now, maintenanceWaitMs = 90000, onStatus = () => {}, language = 'zh' }) { this.paths = paths; this.dataDir = resolve(dataDir); this.stateFile = join(this.dataDir, 'state.json'); this.connectionFile = join(this.dataDir, 'desktop-connection.json'); this.env = { ...env }; this.run = run; this.choosePort = choosePort; this.request = request; this.readOwner=readOwner;this.stopOwner=stopOwner;this.selectRuntime=selectRuntime;this.verifyConnection=verifyConnection;this.wait=wait;this.now=now;this.maintenanceWaitMs=maintenanceWaitMs;this.onStatus=onStatus;this.language=language;this.platform=platform;this.launch=launch;this.started = false; }
  get text() { return TEXT[languageOf(this.language)]; }
  get lang() { return languageOf(this.language); }
  async start() {
    if (!existsSync(this.paths.node) || !existsSync(join(this.paths.host, 'server.mjs'))) throw new Error(this.text.missing);
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    if (this.platform === 'win32') return this.startDirect();
    const remembered = readJSON(this.connectionFile), externalConfigPath = this.env.RNA_DESKTOP_SERVICE_CONFIG ? resolve(this.env.RNA_DESKTOP_SERVICE_CONFIG) : remembered?.managed === false ? remembered.serviceConfig : null;
    if (this.env.RNA_DESKTOP_ISOLATED !== '1' && typeof externalConfigPath === 'string' && isAbsolute(externalConfigPath)) {
      const config = readJSON(externalConfigPath), stateFile = config?.stateFile;
      if (typeof stateFile === 'string' && isAbsolute(stateFile) && externalConfigPath === `${stateFile}.service/config.json` && stateFile !== this.stateFile && readJSON(`${stateFile}.service/maintenance.json`)?.held) {
        const deadline = this.now() + this.maintenanceWaitMs;
        for (;;) {
          this.onStatus(this.text.externalWaiting);
          const connection = await this.verifyConnection(externalConfigPath, { host: this.paths.host, request: this.request });
          if (connection) return this.attachExternal(connection);
          if (this.now() >= deadline) throw Error(this.text.externalHeld);
          await this.wait(500);
        }
      }
    }
    const external = await findExistingService({host:this.paths.host,env:this.env,dataDir:this.dataDir,request:this.request});
    if (external && external.stateFile !== this.stateFile) return this.attachExternal(external);
    let config = readJSON(`${this.stateFile}.service/config.json`);
    if (config && config.stateFile !== this.stateFile) throw new Error(this.text.configMismatch);
    const deadline = this.now() + this.maintenanceWaitMs;
    for (;;) {
      const maintenance = readJSON(`${this.stateFile}.service/maintenance.json`);
      if (!maintenance?.held) break;
      this.onStatus(this.text.waiting);
      const connection = await this.verifyConnection(`${this.stateFile}.service/config.json`, { host: this.paths.host, request: this.request });
      if (connection) {
        config = readJSON(`${this.stateFile}.service/config.json`); const selected = await this.selectRuntime({ paths: this.paths, stateFile: this.stateFile, config, language: this.lang });
        const response = await this.request(`${connection.origin}/api/health`, { signal: AbortSignal.timeout(10000), redirect: 'error' }), health = await response.json();
        if (!response.ok || health.process?.pid !== connection.daemonPid || health.process?.instanceId !== connection.instanceId) throw Error(this.text.maintenanceIdentity);
        assertManagedHealth(health, selected, this.lang); this.servicePaths = selected.paths; this.port = connection.port; this.origin = connection.origin; this.maintenanceAttached = true;
        const result = { ...connection, managed: true, cli: this.paths.cli }; this.writeConnection(result); return result;
      }
      if (this.now() >= deadline) throw Error(this.text.maintenanceHeld);
      await this.wait(500);
    }
    config = readJSON(`${this.stateFile}.service/config.json`);
    const selected = config ? await this.selectRuntime({ paths: this.paths, stateFile: this.stateFile, config, language: this.lang }) : { paths: this.paths }, activePaths = selected.paths; this.servicePaths = activePaths;
    if (selected.release) {
      const connection = await this.verifyConnection(`${this.stateFile}.service/config.json`, { host: this.paths.host, request: this.request });
      if (connection) {
        const response = await this.request(`${connection.origin}/api/health`, { signal: AbortSignal.timeout(10000), redirect: 'error' }), health = await response.json();
        if (!response.ok || health.process?.pid !== connection.daemonPid || health.process?.instanceId !== connection.instanceId) throw Error(this.text.serviceIdentity);
        assertManagedHealth(health, selected, this.lang); this.owner = await this.readOwner({ paths: activePaths, stateFile: this.stateFile, port: connection.port }); this.started = true; this.port = connection.port; this.origin = connection.origin;
        const result = { ...connection, managed: true, cli: this.paths.cli }; this.writeConnection(result); return result;
      }
    }
    const port = config?.port ?? await this.choosePort();
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(this.text.port);
    this.port = port; this.origin = `http://127.0.0.1:${port}`;
    const env = { ...this.env, RNA_AGENT_STATE: this.stateFile, RNA_AGENT_PORT: String(port), PATH: `${activePaths.bin}${delimiter}${this.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'}` };
    delete env.PI_FORGE_STATE; delete env.PI_FORGE_PORT; delete env.ELECTRON_RUN_AS_NODE;
    this.serviceEnv = env;
    let result;
    try { result = await this.run(activePaths.node, [join(activePaths.host, 'service-cli.mjs'), 'service', 'start', '--session'], { cwd: activePaths.host, env, language: this.lang }); }
    finally { this.owner=await this.readOwner({paths:activePaths,stateFile:this.stateFile,port}); }
    if (!result?.childPid || result.address !== this.origin || !this.owner || this.owner.pid!==result.supervisorPid) throw new Error(this.text.receipt);
    this.started = true;
    const response = await this.request(`${this.origin}/api/health`, { signal: AbortSignal.timeout(10000), redirect: 'error' });
    const health = await response.json();
    if (!response.ok || health.modelExecution !== 'rna' || health.process?.pid !== result.childPid) throw new Error(this.text.unverified);
    assertManagedHealth(health, selected, this.lang);
    const connection = { schemaVersion: 1, managed:true, origin: this.origin, port, stateFile: this.stateFile, daemonPid: result.childPid, supervisorPid: result.supervisorPid, instanceId: health.process.instanceId, updatedAt: new Date().toISOString(), cli: this.paths.cli };
    this.writeConnection(connection);
    return connection;
  }
  /**
   * Windows: the service is this app's own child process, for as long as the app is open. The supervised background
   * service the other platforms use identifies processes with ps(1) and stops them with signals, neither of which
   * Windows has; here the app asks the service to stop over their channel, and the service also stops when the app is gone.
   */
  async startDirect() {
    const port = await this.choosePort(); if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(this.text.port);
    this.port = port; this.origin = `http://127.0.0.1:${port}`;
    const env = { ...this.env, RNA_AGENT_STATE: this.stateFile, RNA_AGENT_PORT: String(port), RNA_AGENT_DIRECT: '1', PATH: `${this.paths.bin}${delimiter}${this.env.PATH ?? this.env.Path ?? ''}` };
    for (const name of Object.keys(env)) if (name !== 'PATH' && name.toUpperCase() === 'PATH') delete env[name];
    delete env.PI_FORGE_STATE; delete env.PI_FORGE_PORT; delete env.ELECTRON_RUN_AS_NODE;
    const log = openSync(join(this.dataDir, 'service.log'), 'a');
    let child, exited = null;
    try { child = this.launch(this.paths.node, [join(this.paths.host, 'server.mjs')], { cwd: this.paths.host, env, windowsHide: true, stdio: ['ignore', log, log, 'ipc'] }); } finally { closeSync(log); }
    child.once('exit', code => { exited = code ?? 1; }); child.once('error', () => { exited ??= 1; });
    this.child = child; this.direct = true;
    const deadline = this.now() + 90000;
    for (;;) {
      if (exited !== null) throw new Error(this.text.exited(exited));
      try {
        const response = await this.request(`${this.origin}/api/health`, { signal: AbortSignal.timeout(5000), redirect: 'error' }), health = await response.json();
        if (response.ok) {
          // An answer on this port while the child has already gone is some other process's.
          if (exited !== null) throw new Error(this.text.exited(exited));
          if (health.modelExecution !== 'rna' || health.process?.pid !== child.pid) throw new Error(this.text.unverified);
          this.started = true;
          const connection = { schemaVersion: 1, managed: 'direct', origin: this.origin, port, stateFile: this.stateFile, daemonPid: child.pid, instanceId: health.process.instanceId, updatedAt: new Date().toISOString(), cli: this.paths.cli };
          this.writeConnection(connection); return connection;
        }
      } catch (error) { if (error.message === this.text.unverified) { this.stopDirect(); throw error; } if (exited !== null) throw new Error(this.text.exited(exited)); }
      if (this.now() >= deadline) { this.stopDirect(); throw new Error(this.text.timeout); }
      await this.wait(300);
    }
  }
  /** Ask the child service to finish its work and exit; end it only if it has not gone after the grace period. */
  async stopDirect(graceMs = 25000) {
    const child = this.child; if (!child || child.exitCode !== null || child.signalCode) { this.child = null; this.started = false; return; }
    const gone = new Promise(done => child.once('exit', done));
    try { if (child.connected) child.send({ type: 'rna-daemon-stop' }); else child.kill(); } catch { try { child.kill(); } catch { /* already gone */ } }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, graceMs);
    await gone; clearTimeout(timer); this.child = null; this.started = false;
  }
  async attachExternal(connection) {
    const config = readJSON(connection.serviceConfig), prefix = `${connection.stateFile}.service/releases/`;
    if (typeof config?.command === 'string' && config.command.startsWith(prefix)) {
      const selected = await this.selectRuntime({ paths: this.paths, stateFile: connection.stateFile, config, language: this.lang });
      const response = await this.request(`${connection.origin}/api/health`, { signal: AbortSignal.timeout(10000), redirect: 'error' }), health = await response.json();
      if (!response.ok || health.process?.pid !== connection.daemonPid || health.process?.instanceId !== connection.instanceId) throw Error(this.text.externalIdentity);
      assertManagedHealth(health, selected, this.lang);
    }
    this.origin=connection.origin;this.port=connection.port;this.external=true;this.externalStateFile=connection.stateFile;const result={...connection,cli:this.paths.cli};this.writeConnection(result);return result;
  }
  writeConnection(connection) { writeFileSync(`${this.connectionFile}.tmp`, JSON.stringify(connection,null,2),{mode:0o600});renameSync(`${this.connectionFile}.tmp`,this.connectionFile); }
  async stop() { if (this.direct) return this.stopDirect(); if (this.external||!this.owner) return; await this.stopOwner({paths:this.servicePaths??this.paths,stateFile:this.stateFile,owner:this.owner,language:this.lang});this.owner=null;this.started=false; }
}
module.exports = { DesktopRuntime, runtimePaths, reservePort };
