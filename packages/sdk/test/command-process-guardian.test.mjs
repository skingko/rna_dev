import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnGuardedCommand } from '../src/command-process-guardian.mjs';
import { runCapabilityProcess } from '../src/capability-installation.mjs';
import { createWorkspaceTools } from '../src/workspace-tools.mjs';

const exists = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const kill = pid => { try { process.kill(pid, 'SIGKILL'); } catch {} };
async function until(check, label) { const end = Date.now() + 7000; while (Date.now() < end) { if (await check()) return; await delay(20); } throw new Error(`Timed out: ${label}`); }
async function directory(t) { const path = await mkdtemp(join(tmpdir(), 'rna-command-guardian-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
function collect(child) {
  let stdout = '', stderr = ''; child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; }); child.stdin.on('error', () => {});
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (exitCode, signal) => resolve({ stdout, stderr, exitCode, signal, command: child.commandResult })); });
}

test('command stdin EOF is ordinary input completion, preserving delayed output, backpressure and the exact exit status', async t => {
  const child = spawnGuardedCommand(process.execPath, ['-e', 'let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",x=>input+=x);process.stdin.on("end",()=>setTimeout(()=>{process.stderr.write("diagnostic");process.stdout.write(input,()=>{process.exitCode=23})},150));']);
  t.after(() => child.stop());
  const output = collect(child); child.stdout.pause();
  child.stdin.end('x'.repeat(512 * 1024)); await delay(300); child.stdout.resume();
  const result = await output;
  assert.equal(result.stdout.length, 512 * 1024); assert.equal(result.stderr, 'diagnostic'); assert.equal(result.exitCode, 23); assert.equal(result.command.exitCode, 23); assert.equal(result.command.started, true); assert.equal(result.command.cleanedGroup, true); assert.equal(result.command.outputIncomplete, false);
});

test('the command retains its configured environment while NODE_OPTIONS cannot preload code into its guardian', async t => {
  const dir = await directory(t), record = join(dir, 'preload.jsonl'), preload = join(dir, 'preload.cjs');
  await writeFile(preload, 'require("node:fs").appendFileSync(process.env.RNA_TEST_RECORD,JSON.stringify({pid:process.pid})+"\\n");');
  const child = spawnGuardedCommand(process.execPath, ['-e', 'process.stdout.write(process.env.RNA_TEST_VALUE)'], { cwd: dir, env: { ...process.env, RNA_TEST_RECORD: record, RNA_TEST_VALUE: 'command-environment-preserved', NODE_OPTIONS: `--require=${preload}` } });
  t.after(() => child.stop()); const output = collect(child); child.stdin.end(); const result = await output;
  assert.equal(result.stdout, 'command-environment-preserved'); assert.equal(result.exitCode, 0);
  const records = (await readFile(record, 'utf8')).trim().split('\n').map(JSON.parse); assert.deepEqual(records, [{ pid: result.command.pid }]); assert.notEqual(result.command.pid, child.pid);
});

test('spawn failure is distinguished from a command that started and exited unsuccessfully', async t => {
  const dir = await directory(t), child = spawnGuardedCommand(join(dir, 'not-a-command'), []); t.after(() => child.stop());
  const output = collect(child); child.stdin.end(); const result = await output;
  assert.equal(result.exitCode, 127); assert.equal(result.command.started, false); assert.equal(result.command.error.code, 'ENOENT');
});

test('a stopped command with an unconsuming stdout reader has a bounded close and reports lost output', async t => {
  // A spawn receipt precedes JavaScript initialization. Deliberately delay the
  // writer so this cannot regress to sleeping after the OS spawn notification:
  // stopping before the write correctly reports that no output was lost.
  const child = spawnGuardedCommand(process.execPath, ['-e', 'setTimeout(()=>{process.on("SIGTERM",()=>{});const accepted=process.stdout.write("x".repeat(2*1024*1024));process.stderr.write(JSON.stringify({ready:true,backpressured:!accepted})+"\\n");setInterval(()=>{},1000)},400)']);
  let readiness = ''; child.stderr.on('data', value => { readiness += value; });
  t.after(() => child.stop()); child.stdin.on('error', () => {}); child.stdin.end();
  const closed = new Promise(resolve => child.once('close', resolve));
  await until(() => readiness.includes('\n') && child.stdout.readableLength > 0, 'command has queued output without a consuming reader');
  assert.deepEqual(JSON.parse(readiness), { ready: true, backpressured: true });
  assert.equal(child.commandResult.started, true);
  const start = Date.now(); child.stop(); await closed;
  assert.ok(Date.now() - start < 3000); assert.equal(child.commandResult.cleanedGroup, true); assert.equal(child.commandResult.cleanupUncertain, false); assert.equal(child.commandResult.outputIncomplete, true);
});

async function stubbornTree(dir, { exitRoot = false } = {}) {
  const script = join(dir, 'tree.mjs'), pidsFile = join(dir, 'tree-pids.json');
  await writeFile(script, `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
const leaf=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000)'],{stdio:['ignore','pipe','inherit']});
leaf.stdout.once('data',()=>{writeFileSync(${JSON.stringify(pidsFile)},JSON.stringify({guardian:process.ppid,command:process.pid,grandchild:leaf.pid}));${exitRoot ? 'process.exit(17);' : 'process.stdout.write("ready\\n");'}});
process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
  return { script, pidsFile };
}

test('ordinary root exit clears a TERM-resistant grandchild and inherited output without waiting forever', { skip: process.platform === 'win32' }, async t => {
  const dir = await directory(t), fixture = await stubbornTree(dir, { exitRoot: true });
  const child = spawnGuardedCommand(process.execPath, [fixture.script]); const output = collect(child); child.stdin.end();
  let pids; t.after(() => { child.stop(); for (const pid of Object.values(pids ?? {})) kill(pid); });
  await until(async () => { try { pids = JSON.parse(await readFile(fixture.pidsFile, 'utf8')); return true; } catch { return false; } }, 'owned tree starts');
  const result = await output; assert.equal(result.exitCode, 17); assert.equal(result.command.exitCode, 17); assert.equal(result.command.outputIncomplete, false);
  await until(() => Object.values(pids).every(pid => !exists(pid)), 'ordinary exit reaps owned tree');
});

test('loss of the guardian itself is reported as uncertain without signalling a stale command identity', { skip: process.platform === 'win32' }, async t => {
  const dir = await directory(t), fixture = await stubbornTree(dir);
  const child = spawnGuardedCommand(process.execPath, [fixture.script]); const output = collect(child); child.stdin.end();
  let pids; t.after(() => { child.stop(); for (const pid of Object.values(pids ?? {})) kill(pid); });
  await until(async () => { try { pids = JSON.parse(await readFile(fixture.pidsFile, 'utf8')); return true; } catch { return false; } }, 'owned tree starts');
  child.kill('SIGKILL'); const result = await output;
  assert.equal(result.command.cleanedGroup, false); assert.equal(result.command.cleanupUncertain, true); assert.equal(result.command.outputIncomplete, true);
  assert.ok(exists(pids.command)); assert.ok(exists(pids.grandchild));
});

test('losing the guardian before its start receipt does not claim the command definitely never ran', { skip: process.platform === 'win32' }, async t => {
  const child = spawnGuardedCommand(process.execPath, ['-e', 'process.stdout.write("done")']); const output = collect(child); child.stdin.end();
  t.after(() => child.stop()); child.once('spawn', () => child.kill('SIGKILL'));
  const result = await output;
  assert.equal(result.command.started, false); assert.equal(result.command.startUncertain, true); assert.equal(result.command.cleanupUncertain, true); assert.equal(result.command.cleanedGroup, false);
});

test('the delayed parent fallback kills only its guardian and does not assume ownership of an old command PID', { skip: process.platform === 'win32' }, async t => {
  const dir = await directory(t), fixture = await stubbornTree(dir);
  const child = spawnGuardedCommand(process.execPath, [fixture.script]); const output = collect(child); child.stdin.end();
  let pids; t.after(() => { child.stop(); for (const pid of Object.values(pids ?? {})) kill(pid); });
  await until(async () => { try { pids = JSON.parse(await readFile(fixture.pidsFile, 'utf8')); return true; } catch { return false; } }, 'owned tree starts');
  child.kill('SIGSTOP'); const start = Date.now(); child.stop(); const result = await output;
  assert.ok(Date.now() - start >= 2000); assert.ok(Date.now() - start < 4000);
  assert.equal(result.command.cleanedGroup, false); assert.equal(result.command.cleanupUncertain, true); assert.equal(result.command.outputIncomplete, true);
  assert.ok(exists(pids.command)); assert.ok(exists(pids.grandchild));
});

test('capability timeout keeps its original cause and also reports an unresponsive guardian cleanup uncertainty', { skip: process.platform === 'win32' }, async t => {
  const dir = await directory(t), fixture = await stubbornTree(dir); let pids;
  t.after(() => { for (const pid of Object.values(pids ?? {})) kill(pid); });
  const running = runCapabilityProcess(process.execPath, [fixture.script], { cwd: dir, timeoutMs: 1000 }).then(result => ({ result }), error => ({ error }));
  await until(async () => { try { pids = JSON.parse(await readFile(fixture.pidsFile, 'utf8')); return true; } catch { return false; } }, 'owned tree starts');
  process.kill(pids.guardian, 'SIGSTOP'); const result = await running;
  assert.equal(result.error.code, 'install_timeout'); assert.equal(result.error.details.cleanupUncertain, true); assert.equal(result.error.details.startUncertain, false);
  assert.ok(exists(pids.command)); assert.ok(exists(pids.grandchild));
});

for (const mode of ['workspace', 'capability']) test(`${mode}: guardian failure exposes cleanup uncertainty to its caller`, { skip: process.platform === 'win32' }, async t => {
  const dir = await directory(t), fixture = await stubbornTree(dir); let pids;
  t.after(() => { for (const pid of Object.values(pids ?? {})) kill(pid); });
  const command = `exec '${process.execPath.replaceAll("'", "'\\''")}' '${fixture.script.replaceAll("'", "'\\''")}'`;
  const running = mode === 'workspace'
    ? (await createWorkspaceTools(dir, { includeMutations: true })).find(tool => tool.name === 'project_exec').execute('fixture', { command })
    : runCapabilityProcess(process.execPath, [fixture.script], { cwd: dir }).then(result => ({ result }), error => ({ error }));
  await until(async () => { try { pids = JSON.parse(await readFile(fixture.pidsFile, 'utf8')); return true; } catch { return false; } }, 'owned tree starts');
  kill(pids.guardian); const result = await running;
  if (mode === 'workspace') {
    assert.equal(result.isError, true); assert.equal(result.details.cleanupUncertain, true); assert.equal(result.details.logComplete, false);
    assert.match(result.content[0].text, /Do not automatically replay/);
  } else {
    assert.equal(result.error.code, 'process_cleanup_uncertain'); assert.equal(result.error.details.cleanupUncertain, true);
  }
  assert.ok(exists(pids.command)); assert.ok(exists(pids.grandchild));
});

for (const mode of ['workspace', 'capability']) test(`${mode}: SIGKILL of the SDK host reaps its command guardian and stubborn descendants only`, { skip: process.platform === 'win32' }, async t => {
  const dir = await directory(t), fixture = await stubbornTree(dir), hostScript = join(dir, 'host.mjs');
  const workspaceModule = pathToFileURL(fileURLToPath(new URL('../src/workspace-tools.mjs', import.meta.url))).href;
  const capabilityModule = pathToFileURL(fileURLToPath(new URL('../src/capability-installation.mjs', import.meta.url))).href;
  const command = `exec '${process.execPath.replaceAll("'", "'\\''")}' '${fixture.script.replaceAll("'", "'\\''")}'`;
  await writeFile(hostScript, mode === 'workspace'
    ? `import {createWorkspaceTools} from ${JSON.stringify(workspaceModule)};const tools=await createWorkspaceTools(${JSON.stringify(dir)},{includeMutations:true});await tools.find(x=>x.name==='project_exec').execute('fixture',{command:${JSON.stringify(command)}});`
    : `import {runCapabilityProcess} from ${JSON.stringify(capabilityModule)};await runCapabilityProcess(process.execPath,[${JSON.stringify(fixture.script)}],{cwd:${JSON.stringify(dir)}});`);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const host = spawn(process.execPath, [hostScript], { stdio: ['ignore', 'pipe', 'pipe'] }); let diagnostic = ''; host.stdout.resume(); host.stderr.on('data', value => { diagnostic += value; });
  let pids; t.after(() => { for (const pid of [host.pid, unrelated.pid, ...Object.values(pids ?? {})]) kill(pid); });
  await until(async () => { try { pids = JSON.parse(await readFile(fixture.pidsFile, 'utf8')); return true; } catch { if (host.exitCode !== null) throw new Error(`Host exited before tree startup: ${diagnostic}`); return false; } }, 'command tree starts');
  const ended = new Promise(resolve => host.once('exit', resolve)); host.kill('SIGKILL'); await ended;
  await until(() => Object.values(pids).every(pid => !exists(pid)), 'guardian and command tree exit after host SIGKILL');
  assert.ok(exists(unrelated.pid), 'Unrelated processes are outside the owned group'); assert.equal(diagnostic, '');
});

test('capability commands retain stdin results, exit errors, output limits, timeout and cancellation', async t => {
  const dir = await directory(t);
  const echo = await runCapabilityProcess(process.execPath, ['-e', 'let x="";process.stdin.on("data",v=>x+=v);process.stdin.on("end",()=>setTimeout(()=>process.stdout.write(x),80))'], { cwd: dir, input: '{"value":42}\n' });
  assert.equal(echo.stdout, '{"value":42}\n'); assert.equal(echo.exitCode, 0);
  await assert.rejects(runCapabilityProcess(process.execPath, ['-e', 'process.stderr.write("checked error");process.exitCode=29'], { cwd: dir }), error => error.code === 'process_failed' && error.details.exitCode === 29 && error.details.diagnostic === 'checked error');
  await assert.rejects(runCapabilityProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(8192));setInterval(()=>{},1000)'], { cwd: dir, maxBytes: 1000 }), { code: 'output_limit' });
  await assert.rejects(runCapabilityProcess(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { cwd: dir, timeoutMs: 100 }), { code: 'install_timeout' });
  const abort = new AbortController(), running = runCapabilityProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: dir, signal: abort.signal }); setTimeout(() => abort.abort(), 100);
  await assert.rejects(running, { name: 'AbortError' });
});
