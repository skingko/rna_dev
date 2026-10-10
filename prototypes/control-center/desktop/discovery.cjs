const { readFileSync, readdirSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { homedir } = require('node:os');
const { isAbsolute, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const read = file => JSON.parse(readFileSync(file,'utf8'));
async function verifyService(configPath, { host, request = fetch, identities } = {}) {
  if (!isAbsolute(configPath)) return null;
  try {
    const config = read(configPath), state = config.stateFile;
    if (typeof state !== 'string' || !isAbsolute(state) || resolve(configPath) !== `${state}.service/config.json` || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) return null;
    const status = read(`${state}.service/status.json`), supervisor = read(`${state}.service/supervisor.lock`), owner = read(`${state}.lock`);
    const identity = identities ?? await import(pathToFileURL(join(host,'process-lease.mjs')).href);
    if (supervisor.pid !== status.supervisorPid || owner.pid !== status.childPid || supervisor.supervisorRunId !== status.runId || owner.supervisorRunId !== status.runId || owner.generation !== status.generation || owner.stateFile !== state || !supervisor.birth || !owner.birth || !identity.processAlive(supervisor.pid) || !identity.processAlive(owner.pid) || identity.processBirth(supervisor.pid) !== supervisor.birth || identity.processBirth(owner.pid) !== owner.birth) return null;
    const origin = `http://127.0.0.1:${config.port}`, response = await request(`${origin}/api/health`,{signal:AbortSignal.timeout(3000),redirect:'error'});
    if (!response.ok) return null; const health = await response.json();
    if (health.modelExecution !== 'rna' || !['openviking', 'embedded'].includes(health.memoryBackend) || health.process?.pid !== owner.pid || health.process?.supervisorRunId !== status.runId || health.process?.generation !== owner.generation || health.process?.closing) return null;
    return { schemaVersion:1, managed:false, origin, port:config.port,stateFile:state,daemonPid:owner.pid,supervisorPid:supervisor.pid,instanceId:health.process.instanceId,serviceConfig:configPath,updatedAt:new Date().toISOString() };
  } catch { return null; }
}
async function findExistingService({ host, env=process.env, dataDir, request=fetch } = {}) {
  if (env.RNA_DESKTOP_ISOLATED === '1') return null;
  const candidates=[];
  if (env.RNA_DESKTOP_SERVICE_CONFIG) candidates.push(resolve(env.RNA_DESKTOP_SERVICE_CONFIG));
  else {
    if (env.RNA_DESKTOP_DATA) return null;
    try { const connection=read(join(dataDir,'desktop-connection.json'));if(connection.managed===false&&connection.serviceConfig)candidates.push(connection.serviceConfig); } catch {}
    try { const directory=join(homedir(),'Library/LaunchAgents');for(const name of readdirSync(directory).filter(name=>/^local\.rna-agent\.[a-f0-9]+\.plist$/.test(name)).sort()) { try { const plist=JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-',join(directory,name)],{encoding:'utf8',timeout:2000,maxBuffer:65536}));const args=plist.ProgramArguments;if(Array.isArray(args)&&args.length===3&&args[1].endsWith('/daemon-supervisor.mjs'))candidates.push(args[2]); }catch{} } } catch {}
  }
  for (const path of [...new Set(candidates)]) { const match=await verifyService(path,{host,request});if(match)return match; }
  return null;
}
module.exports={findExistingService,verifyService};
