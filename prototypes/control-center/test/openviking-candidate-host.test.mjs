import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWrite, readJSON } from '../durable-files.mjs';
import { processAlive, processBirth } from '../process-lease.mjs';

async function until(check, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const result = check(); if (result) return result; await delay(20); }
  throw new Error(message);
}
test('foreground candidate controller ignores stale stop, persists identity and closes its owned helper on matched stop', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rna-candidate-host-'));
  const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const helper = join(directory, 'helper.mjs'), descriptor = join(directory, 'helper.json'), control = join(directory, 'control');
  writeFileSync(helper, `import http from 'node:http';import{readFileSync}from'node:fs';
const env=process.env;const end=Date.now()+5000;let admitted=false;
while(Date.now()<end){try{const o=JSON.parse(readFileSync(env.RNA_MANAGED_HELPER_OWNER_FILE));if(o.phase==='running'&&o.pid===process.pid&&o.token===env.RNA_MANAGED_HELPER_TOKEN&&o.fingerprint===env.RNA_MANAGED_HELPER_FINGERPRINT){admitted=true;break}}catch{}await new Promise(r=>setTimeout(r,10));}
if(!admitted)process.exit(75);
http.createServer((q,s)=>s.end(JSON.stringify({ok:true,managedHelper:{id:env.RNA_MANAGED_HELPER_ID,token:env.RNA_MANAGED_HELPER_TOKEN,fingerprint:env.RNA_MANAGED_HELPER_FINGERPRINT,pid:process.pid}}))).listen(${port},'127.0.0.1');
process.on('SIGTERM',()=>process.exit(0));`);
  atomicWrite(descriptor, JSON.stringify({ schemaVersion: 1, id: 'candidate-fixture', command: process.execPath, args: [helper], cwd: directory,
    healthUrl: `http://127.0.0.1:${port}/health`, healthIdentity: 'rna-helper-v1', healthTimeoutMs: 1000, startupGraceMs: 5000 }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../../scripts/openviking-candidate-host.mjs', import.meta.url)), control, descriptor], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; }); child.stdout.resume();
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; } rmSync(directory, { recursive: true, force: true }); });
  const statusFile = join(control, 'status.json');
  const running = await until(() => { const state = readJSON(statusFile); return state?.phase === 'running' && state; }, `candidate did not become ready: ${stderr}`);
  assert.equal(running.pid, child.pid); assert.equal(running.birth, processBirth(child.pid));
  const helperPid = running.managedHelpers.helpers[0].pid;
  atomicWrite(running.controlPath, JSON.stringify({ runId: 'stale-generation', action: 'stop' })); await delay(1200);
  assert.equal(processAlive(child.pid), true); assert.equal(processAlive(helperPid), true);
  atomicWrite(running.controlPath, JSON.stringify({ runId: running.runId, action: 'stop' }));
  const ended = await exited; assert.equal(ended.code, 0, stderr); assert.equal(ended.signal, null);
  const stopped = readJSON(statusFile); assert.equal(stopped.phase, 'stopped'); assert.equal(stopped.runId, running.runId);
  assert.equal(stopped.managedHelpers.helpers[0].phase, 'stopped'); assert.equal(processAlive(helperPid), false);
});
