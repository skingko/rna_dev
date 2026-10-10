import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { atomicWrite } from '../durable-files.mjs';
import { createEnduranceRun, EnduranceMonitor } from '../endurance-monitor.mjs';

const origin = Date.parse('2026-09-24T00:00:00.000Z');
const health = { ok: true, process: { instanceId: 'fixture-instance', pid: 1 } };
const startRequest = (requestId, runId, at = origin) => ({ requestId, action: 'start', run: createEnduranceRun({ id: runId, now: at, keepAwake: false }) });
async function temporary(t) { const directory = await mkdtemp(join(tmpdir(), 'rna-endurance-control-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }
const report = async directory => JSON.parse(await readFile(join(directory, 'endurance.json'), 'utf8'));
const sendRequest = (directory, request) => atomicWrite(join(directory, 'endurance-request.json'), JSON.stringify(request));

test('supervisor consumes commands before sample throttling and an acknowledged stop is durable across repeated polls and restart', async t => {
  const directory = await temporary(t), monitor = new EnduranceMonitor(directory);
  sendRequest(directory, startRequest('start-A', 'run-A'));
  const first = monitor.sample(health, { at: origin }); assert.equal(first.lastRequestId, 'start-A'); assert.equal(first.lastRequest.status, 'applied'); assert.equal(first.samples, 1);
  const duplicate = monitor.sample(health, { at: origin + 1000 }); assert.deepEqual(duplicate, first, 'duplicate control delivery neither resets nor grows counters');
  sendRequest(directory, { requestId: 'stop-A', action: 'stop', runId: 'run-A' });
  const stopped = monitor.sample(health, { at: origin + 2000 }); assert.equal(stopped.status, 'stopped'); assert.equal(stopped.lastRequestId, 'stop-A'); assert.equal(stopped.passed, null); assert.equal(stopped.samples, 1, 'stop is applied before the minute sampling interval elapses');
  const bytes = await readFile(monitor.path, 'utf8'); monitor.sample(health, { at: origin + 100000 }); new EnduranceMonitor(directory).sample(health, { at: origin + 200000 }); assert.equal(await readFile(monitor.path, 'utf8'), bytes);
  assert.equal(JSON.parse(await readFile(monitor.requestPath, 'utf8')).requestId, 'stop-A', 'the reader must not remove a potentially newer request');
});
test('a new run archives the complete stopped report and stale run-specific commands cannot stop or resurrect it', async t => {
  const directory = await temporary(t), monitor = new EnduranceMonitor(directory);
  sendRequest(directory, startRequest('start-A', 'run-A')); monitor.sample(health, { at: origin });
  sendRequest(directory, { requestId: 'stop-A', action: 'stop', runId: 'run-A' }); const old = monitor.sample(health, { at: origin + 1000 });
  sendRequest(directory, startRequest('start-B', 'run-B', origin + 2000)); const current = monitor.sample(health, { at: origin + 2000 }); assert.equal(current.id, 'run-B'); assert.equal(current.samples, 1);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'endurance-run-A.json'), 'utf8')), old);
  const samples = (await readFile(monitor.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(samples.map(sample => sample.runId), ['run-A', 'run-B'], 'shared rotated samples retain their own run identity across observation replacement');
  assert.equal(current.observedHealthySeconds, 0, 'a new observation does not inherit old healthy time');
  sendRequest(directory, { requestId: 'late-stop-A', action: 'stop', runId: 'run-A' }); let run = monitor.sample(health, { at: origin + 3000 }); assert.equal(run.id, 'run-B'); assert.equal(run.status, 'running'); assert.equal(run.lastRequest.status, 'ignored'); assert.equal(run.lastRequest.reason, 'run_id_mismatch');
  sendRequest(directory, startRequest('late-start-A', 'run-A')); run = monitor.sample(health, { at: origin + 4000 }); assert.equal(run.id, 'run-B'); assert.equal(run.lastRequest.status, 'ignored');
  sendRequest(directory, { requestId: 'stop-B', action: 'stop', runId: 'run-B' }); monitor.sample(health, { at: origin + 5000 });
  sendRequest(directory, startRequest('even-later-start-A', 'run-A')); run = monitor.sample(health, { at: origin + 6000 }); assert.equal(run.id, 'run-B'); assert.equal(run.status, 'stopped'); assert.equal(run.lastRequest.reason, 'stale_start_request');
});
test('start commands cannot manufacture uptime, replace a running observation, or recreate an already processed run', async t => {
  const directory = await temporary(t), monitor = new EnduranceMonitor(directory), request = startRequest('start-A', 'run-A');
  Object.assign(request.run, { passed: true, observedHealthySeconds: 360000, samples: 10000, status: 'completed', completedAt: new Date(origin).toISOString() });
  sendRequest(directory, request); let run = monitor.sample(health, { at: origin }); assert.equal(run.status, 'running'); assert.equal(run.passed, null); assert.equal(run.samples, 1); assert.equal(run.observedHealthySeconds, 0);
  sendRequest(directory, startRequest('replace-running', 'run-B', origin + 1000)); run = monitor.sample(health, { at: origin + 1000 }); assert.equal(run.id, 'run-A'); assert.equal(run.lastRequest.reason, 'already_running');
  sendRequest(directory, { requestId: 'stop-A', action: 'stop', runId: 'run-A' }); monitor.sample(health, { at: origin + 2000 });
  sendRequest(directory, startRequest('duplicate-start-A', 'run-A', origin + 3000)); run = monitor.sample(health, { at: origin + 3000 }); assert.equal(run.status, 'stopped'); assert.equal(run.lastRequest.reason, 'run_already_processed');
});
test('invalid and no-run commands are acknowledged without creating a fictitious observation or unsafe archive path', async t => {
  const directory = await temporary(t), monitor = new EnduranceMonitor(directory);
  sendRequest(directory, { requestId: 'stop-before-start', action: 'stop', runId: 'missing' }); let run = monitor.sample(health, { at: origin }); assert.equal(run.status, 'not_started'); assert.equal(run.samples, undefined); assert.equal(run.lastRequest.status, 'ignored');
  const bad = startRequest('unsafe-start', 'safe'); bad.run.id = '../outside'; sendRequest(directory, bad); run = monitor.sample(health, { at: origin + 1000 }); assert.equal(run.status, 'not_started'); assert.equal(run.lastRequest.reason, 'invalid_start_request');
  sendRequest(directory, { requestId: 'unknown-command', action: 'reset-success' }); run = monitor.sample(health, { at: origin + 2000 }); assert.equal(run.lastRequest.reason, 'invalid_action'); assert.equal((await readdir(directory)).filter(name => name.startsWith('endurance-') && name !== 'endurance-request.json').length, 0);
});
test('a prior archive revision is retained when a new start archives a later stopped revision of the same run', async t => {
  const directory = await temporary(t), monitor = new EnduranceMonitor(directory);
  sendRequest(directory, startRequest('start-A', 'run-A')); const first = monitor.sample(health, { at: origin }); atomicWrite(join(directory, 'endurance-run-A.json'), JSON.stringify(first));
  sendRequest(directory, { requestId: 'stop-A', action: 'stop', runId: 'run-A' }); const stopped = monitor.sample(health, { at: origin + 1000 });
  sendRequest(directory, startRequest('start-B', 'run-B', origin + 2000)); monitor.sample(health, { at: origin + 2000 });
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'endurance-run-A.json'), 'utf8')), first);
  const revisions = (await readdir(directory)).filter(name => /^endurance-run-A-[a-f0-9]{16}\.json$/.test(name)); assert.equal(revisions.length, 1); assert.deepEqual(JSON.parse(await readFile(join(directory, revisions[0]), 'utf8')), stopped);
});

async function monitorProcess(t, directory) {
  const module = new URL('../endurance-monitor.mjs', import.meta.url).href;
  const source = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; import {EnduranceMonitor} from ${JSON.stringify(module)};
    const directory=process.env.TEST_MONITOR_DIRECTORY, monitor=new EnduranceMonitor(directory), original=fs.renameSync;
    let pause=false; const buffer=new Int32Array(new SharedArrayBuffer(4));
    fs.renameSync=(from,to)=>{ if(pause && to===monitor.path){ pause=false; process.send({type:'paused-before-commit'}); const deadline=Date.now()+10000; while(!fs.existsSync(directory+'/continue-sample')){ if(Date.now()>deadline)throw Error('sample barrier timed out'); Atomics.wait(buffer,0,0,10); } fs.unlinkSync(directory+'/continue-sample'); } return original(from,to); }; syncBuiltinESMExports();
    process.on('message', message=>{ if(message.type==='close'){process.exit(0);return;} if(message.type==='sample'){ try{pause=message.pause===true; const value=monitor.sample(message.health,{at:message.at});process.send({type:'sampled',report:value});}catch(error){process.send({type:'failed',message:error.message});} } }); process.send({type:'ready'});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, TEST_MONITOR_DIRECTORY: directory }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const queued = [], pending = []; let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('message', message => { const index = pending.findIndex(item => item.type === message.type || message.type === 'failed'); if (index < 0) queued.push(message); else { const item = pending.splice(index, 1)[0]; clearTimeout(item.timer); message.type === 'failed' ? item.reject(new Error(message.message)) : item.resolve(message); } });
  const exited = new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { for (const item of pending.splice(0)) { clearTimeout(item.timer); item.reject(new Error(`Monitor exited (${code ?? signal}): ${stderr}`)); } done({ code, signal }); }); });
  const receive = type => { const index = queued.findIndex(message => message.type === type || message.type === 'failed'); if (index >= 0) { const message = queued.splice(index, 1)[0]; return message.type === 'failed' ? Promise.reject(new Error(message.message)) : Promise.resolve(message); } return new Promise((resolve, reject) => { const item = { type, resolve, reject, timer: setTimeout(() => reject(new Error(`Monitor did not report ${type}: ${stderr}`)), 12000) }; pending.push(item); }); };
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  await receive('ready'); return { child, receive, exited };
}
test('cross-process stop arriving between old sample read and rename remains pending, then cannot be overwritten after acknowledgement', async t => {
  const directory = await temporary(t), worker = await monitorProcess(t, directory);
  sendRequest(directory, startRequest('start-race', 'race-run')); worker.child.send({ type: 'sample', health, at: origin }); await worker.receive('sampled');
  const before = await readFile(join(directory, 'endurance.json'), 'utf8');
  worker.child.send({ type: 'sample', health, at: origin + 60000, pause: true }); await worker.receive('paused-before-commit');
  sendRequest(directory, { requestId: 'stop-during-commit', action: 'stop', runId: 'race-run' });
  assert.equal(await readFile(join(directory, 'endurance.json'), 'utf8'), before, 'the control process writes only the request, never the live report');
  await writeFile(join(directory, 'continue-sample'), 'continue'); const lateSample = await worker.receive('sampled'); assert.equal(lateSample.report.status, 'running'); assert.equal(lateSample.report.lastRequestId, 'start-race');
  assert.equal(JSON.parse(await readFile(join(directory, 'endurance-request.json'), 'utf8')).requestId, 'stop-during-commit', 'late sample commit cannot discard the pending stop');
  worker.child.send({ type: 'sample', health, at: origin + 60001 }); const stopped = (await worker.receive('sampled')).report; assert.equal(stopped.status, 'stopped'); assert.equal(stopped.lastRequestId, 'stop-during-commit'); assert.equal(stopped.lastRequest.status, 'applied');
  const acknowledged = await readFile(join(directory, 'endurance.json'), 'utf8');
  for (let index = 1; index <= 3; index++) { worker.child.send({ type: 'sample', health, at: origin + 60001 + index * 60000 }); await worker.receive('sampled'); assert.equal(await readFile(join(directory, 'endurance.json'), 'utf8'), acknowledged); }
  worker.child.send({ type: 'close' }); await worker.exited;
  const restarted = await monitorProcess(t, directory); restarted.child.send({ type: 'sample', health, at: origin + 360000 }); assert.equal((await restarted.receive('sampled')).report.status, 'stopped'); assert.equal(await readFile(join(directory, 'endurance.json'), 'utf8'), acknowledged);
  assert.equal((await report(directory)).passed, null);
});
