const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { DesktopRuntime, runtimePaths, reservePort } = require('../runtime.cjs');
function fixture(t, overrides = {}) {
  const temp = mkdtempSync(join(tmpdir(),'rna-desktop-runtime-')), host = join(temp,'host'), dataDir = join(temp,'private');mkdirSync(host);writeFileSync(join(host,'server.mjs'),'');writeFileSync(join(temp,'node'),'');t.after(()=>rmSync(temp,{recursive:true,force:true}));
  const calls=[], paths={host,node:join(temp,'node'),bin:join(temp,'bin'),cli:join(temp,'rna')}, stopped=[],runtime=new DesktopRuntime({paths,dataDir,env:{RNA_DESKTOP_ISOLATED:'1',RNA_AGENT_STATE:'/existing-production/state.json',RNA_AGENT_PORT:'4317',PI_FORGE_PORT:'4317',ELECTRON_RUN_AS_NODE:'1',PATH:'/usr/bin'},choosePort:async()=>45234,run:async(...args)=>{calls.push(args);return{childPid:100,supervisorPid:99,address:'http://127.0.0.1:45234'};},request:async()=>Response.json({modelExecution:'rna',process:{pid:100,instanceId:'instance'}}),readOwner:async()=>({pid:99,birth:'born',token:'owned',supervisorRunId:'run'}),stopOwner:async owner=>stopped.push(owner),...overrides});return{temp,host,dataDir,calls,stopped,paths,runtime};
}
test('desktop private supervisor uses bundled Node and isolated state, never inherited production port/state',async t=>{const f=fixture(t);const connection=await f.runtime.start();assert.equal(connection.port,45234);assert.equal(connection.stateFile,join(f.dataDir,'state.json'));const [program,args,options]=f.calls[0];assert.equal(program,f.paths.node);assert.deepEqual(args.slice(1),['service','start','--session']);assert.equal(options.env.RNA_AGENT_PORT,'45234');assert.equal(options.env.RNA_AGENT_STATE,connection.stateFile);assert.equal(options.env.PI_FORGE_PORT,undefined);assert.equal(options.env.ELECTRON_RUN_AS_NODE,undefined);assert.ok(options.env.PATH.startsWith(f.paths.bin));assert.deepEqual(JSON.parse(readFileSync(join(f.dataDir,'desktop-connection.json'))),connection);await f.runtime.stop();assert.equal(f.calls.length,1);assert.equal(f.stopped[0].owner.pid,99);assert.equal(f.stopped[0].stateFile,connection.stateFile);});
test('desktop retains existing private port and rejects foreign state before calling process tools',async t=>{const f=fixture(t);mkdirSync(`${f.runtime.stateFile}.service`,{recursive:true});writeFileSync(`${f.runtime.stateFile}.service/config.json`,JSON.stringify({stateFile:'/foreign/state.json',port:4317}));await assert.rejects(f.runtime.start(),/不匹配/);assert.equal(f.calls.length,0);writeFileSync(`${f.runtime.stateFile}.service/config.json`,JSON.stringify({stateFile:f.runtime.stateFile,port:45234}));f.runtime.choosePort=()=>{throw Error('must reuse');};await f.runtime.start();assert.equal(f.runtime.port,45234);});
test('desktop health PID mismatch does not connect UI and still permits stopping its owned service',async t=>{const f=fixture(t,{request:async()=>Response.json({modelExecution:'rna',process:{pid:777}})});await assert.rejects(f.runtime.start(),/服务身份/);assert.equal(f.runtime.started,true);await f.runtime.stop();assert.equal(f.runtime.started,false);});
test('desktop failed shutdown preserves ownership for a later retry',async t=>{const f=fixture(t);await f.runtime.start();f.runtime.stopOwner=async()=>{throw Error('drain delayed');};await assert.rejects(f.runtime.stop(),/drain delayed/);assert.equal(f.runtime.started,true);assert.ok(f.runtime.owner);});
test('packaged paths preserve host-to-SDK layout without using source checkout or system Node',()=>{const paths=runtimePaths({packaged:true,appPath:'/Applications/Rna Agent.app/Contents/Resources/app'});assert.equal(paths.host,'/Applications/Rna Agent.app/Contents/Resources/app/runtime/prototypes/control-center');assert.equal(paths.node,'/Applications/Rna Agent.app/Contents/Resources/app/runtime/bin/node');});
test('ephemeral desktop port is allocated on loopback in unprivileged range',async()=>{const port=await reservePort();assert.ok(Number.isInteger(port)&&port>=1024&&port<=65535);});

// Windows: no ps(1) and no signal that asks for a clean stop, so the service is the app's own child process.
const { EventEmitter } = require('node:events');
function directFixture(t, { health = pid => ({ modelExecution: 'rna', process: { pid, instanceId: 'instance-1' } }), exitsWith = null } = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'rna-desktop-direct-')), host = join(temp, 'host'), dataDir = join(temp, 'private'); mkdirSync(host); writeFileSync(join(host, 'server.mjs'), ''); writeFileSync(join(temp, 'node.exe'), ''); t.after(() => rmSync(temp, { recursive: true, force: true }));
  const launched = [], sent = [], child = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null, connected: true, killed: 0, send(message) { sent.push(message); queueMicrotask(() => { child.exitCode = 0; child.emit('exit', 0); }); }, kill() { child.killed++; child.exitCode = 1; child.emit('exit', 1); } });
  const paths = { host, node: join(temp, 'node.exe'), bin: join(temp, 'bin'), cli: join(temp, 'rna.cmd') };
  const runtime = new DesktopRuntime({ paths, dataDir, platform: 'win32', env: { Path: 'C:\\Windows', RNA_AGENT_PORT: '4317', ELECTRON_RUN_AS_NODE: '1' }, choosePort: async () => 45300, wait: async () => {},
    launch: (program, args, options) => { launched.push([program, args, options]); if (exitsWith !== null) queueMicrotask(() => child.emit('exit', exitsWith)); return child; },
    request: async () => Response.json(health(child.pid)), run: async () => { throw Error('the supervised service is not used on Windows'); } });
  return { runtime, paths, dataDir, launched, sent, child };
}
test('Windows: packaged paths name node.exe and rna.cmd', () => {
  const paths = runtimePaths({ packaged: true, appPath: join('C:', 'app'), platform: 'win32' });
  assert.equal(paths.node, join('C:', 'app', 'runtime', 'bin/node.exe')); assert.equal(paths.cli, join('C:', 'app', 'runtime', 'bin/rna.cmd'));
  assert.equal(runtimePaths({ packaged: true, appPath: '/app', platform: 'linux' }).node, join('/app', 'runtime', 'bin/node'));
});
test('Windows: the service starts as the app\'s own child with its own state and port, and is asked to stop over the channel', async t => {
  const f = directFixture(t), connection = await f.runtime.start();
  const [program, args, options] = f.launched[0];
  assert.equal(program, f.paths.node); assert.deepEqual(args, [join(f.paths.host, 'server.mjs')]); assert.equal(options.stdio.at(-1), 'ipc'); assert.equal(options.windowsHide, true);
  assert.equal(options.env.RNA_AGENT_STATE, join(f.dataDir, 'state.json')); assert.equal(options.env.RNA_AGENT_PORT, '45300'); assert.equal(options.env.RNA_AGENT_DIRECT, '1'); assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(Object.keys(options.env).filter(name => name.toUpperCase() === 'PATH').join(), 'PATH', 'one PATH, whatever its spelling was'); assert.ok(options.env.PATH.startsWith(f.paths.bin) && options.env.PATH.endsWith('C:\\Windows'));
  assert.deepEqual({ managed: connection.managed, port: connection.port, daemonPid: connection.daemonPid, instanceId: connection.instanceId, cli: connection.cli }, { managed: 'direct', port: 45300, daemonPid: 4242, instanceId: 'instance-1', cli: f.paths.cli });
  assert.equal(JSON.parse(readFileSync(join(f.dataDir, 'desktop-connection.json'), 'utf8')).managed, 'direct');
  await f.runtime.stop();
  assert.deepEqual(f.sent, [{ type: 'rna-daemon-stop' }]); assert.equal(f.child.killed, 0, 'a service that leaves when asked is not killed'); assert.equal(f.runtime.started, false);
});
test('Windows: a service that exits at once, or answers as another process, is not connected', async t => {
  await assert.rejects(directFixture(t, { exitsWith: 3 }).runtime.start(), /（3）/);
  const other = directFixture(t, { health: () => ({ modelExecution: 'rna', process: { pid: 1, instanceId: 'x' } }) });
  await assert.rejects(other.runtime.start(), /无法核对本机服务身份/); assert.deepEqual(other.sent, [{ type: 'rna-daemon-stop' }], 'the child it started is asked to stop');
});
