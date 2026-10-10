const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { setTimeout: sleep } = require('node:timers/promises');
const read = file => { try { return JSON.parse(readFileSync(file,'utf8')); } catch (error) { if(error.code==='ENOENT')return null;throw error; } };
// Refusals shown in the desktop's quit dialog, in the interface language it passes.
const TEXT = { zh: { maintenance: '无法核对应用维护状态，未停止服务。', stopping: '应用自有后台仍在完成退出，请稍后重试。' }, en: { maintenance: 'Could not check the app maintenance state, so the service was not stopped.', stopping: 'The app\'s background service is still shutting down; try again later.' } };
async function readOwnedSupervisor({ paths, stateFile, port, identities }) {
  const config=read(`${stateFile}.service/config.json`), owner=read(`${stateFile}.service/supervisor.lock`), status=read(`${stateFile}.service/status.json`);
  if(!config||config.stateFile!==stateFile||config.port!==port||config.command!==paths.node||config.cwd!==paths.host||config.manager!=='session'||!owner?.token||!owner.birth||owner.supervisorRunId!==status?.runId||owner.pid!==status.supervisorPid)return null;
  const identity=identities??await import(pathToFileURL(join(paths.host,'process-lease.mjs')).href);
  if(!identity.processAlive(owner.pid)||identity.processBirth(owner.pid)!==owner.birth)return null;
  return {pid:owner.pid,birth:owner.birth,token:owner.token,supervisorRunId:owner.supervisorRunId};
}
async function stopOwnedSupervisor({ paths,stateFile,owner,identities,signal=(pid,name)=>process.kill(pid,name),wait=sleep,timeoutMs=35000,acquire,acquireMaintenance,writeIntent,language='zh' }) {
  const text=TEXT[language==='en'?'en':'zh'];
  const identity=identities??await import(pathToFileURL(join(paths.host,'process-lease.mjs')).href);
  const release=await (acquire??identity.acquireProcessLease)(`${stateFile}.service/operation.lock`);
  let releaseMaintenance;
  try {
    releaseMaintenance = await (acquireMaintenance ?? identity.acquireProcessLease)(`${stateFile}.service/maintenance-control.lock`);
    const maintenance = read(`${stateFile}.service/maintenance.json`);
    if (maintenance && (maintenance.schemaVersion !== 1 || typeof maintenance.held !== 'boolean')) throw Error(text.maintenance);
    if (maintenance?.held) return { stopped: false, reason: 'maintenance_held' };
    const current=read(`${stateFile}.service/supervisor.lock`);
    if(!current||['pid','birth','token','supervisorRunId'].some(key=>current[key]!==owner[key]))return {stopped:false,reason:'ownership_changed'};
    const alive=()=>identity.processAlive(owner.pid)&&identity.processBirth(owner.pid)===owner.birth;
    if(!alive())return{stopped:true};
    const atomicWrite=writeIntent??(await import(pathToFileURL(join(paths.host,'durable-files.mjs')).href)).atomicWrite;
    atomicWrite(`${stateFile}.service/intent.json`,JSON.stringify({enabled:false,updatedAt:new Date().toISOString()}));
    // Serialize against CLI service restart, then signal only this pinned owner.
    // Its existing supervisor drains the daemon and tools; no force-kill here.
    signal(owner.pid,'SIGTERM');const deadline=Date.now()+timeoutMs;
    while(alive()){if(Date.now()>deadline)throw new Error(text.stopping);await wait(100);}
    return{stopped:true};
  } finally {releaseMaintenance?.();release();}
}
module.exports={readOwnedSupervisor,stopOwnedSupervisor};
