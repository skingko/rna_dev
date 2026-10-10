import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSession } from '../../../packages/sdk/src/session.mjs';
import { createWorkspaceTools } from '../../../packages/sdk/src/workspace-tools.mjs';
import { Store } from '../store.mjs';
import { CapabilityService } from '../capability-service.mjs';
import { CapabilityInstallService } from '../capability-install-service.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 32000, maxOutputTokens: 1000 };
const exists = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const kill = pid => { try { process.kill(pid, 'SIGKILL'); } catch {} };
async function until(check) { const end = Date.now() + 5000; while (Date.now() < end) { if (await check()) return; await delay(20); } throw new Error('Isolated command did not start'); }
async function fixture(t, git = false) {
  const directory = await mkdtemp(join(tmpdir(), 'rna-command-uncertainty-'));
  const script = join(directory, git ? 'git-fixture' : 'command.mjs'), pidsFile = join(directory, 'pids.json'); let pids;
  await writeFile(script, `#!${process.execPath}\nimport {writeFileSync,mkdirSync} from 'node:fs';import {dirname} from 'node:path';
const stagingDir=${git ? 'dirname(process.argv.at(-1))' : 'undefined'};if(stagingDir)mkdirSync(stagingDir,{recursive:true});
writeFileSync(${JSON.stringify(pidsFile)},JSON.stringify({guardian:process.ppid,command:process.pid,stagingDir}));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`, { mode: 0o700 });
  t.after(async () => { if (pids) { kill(pids.guardian); kill(pids.command); } await rm(directory, { recursive: true, force: true }); });
  return { directory, script, started: async () => { await until(async () => { try { pids = JSON.parse(await readFile(pidsFile, 'utf8')); return true; } catch { return false; } }); return pids; } };
}

for (const mode of ['workspace', 'read-idempotent-command', 'capability-install']) test(`${mode}: real guardian loss stops the SDK model loop and persists explicit recovery`, { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, mode === 'capability-install');
  const store = new Store(join(f.directory, 'state.json')), project = store.createProject({ name: 'Isolated uncertainty', workspace: f.directory }).project;
  const capabilities = new CapabilityService(store), installs = new CapabilityInstallService(store, { capabilityService: capabilities, installerOptions: { gitCommand: f.script } });
  const command = `exec '${process.execPath.replaceAll("'", "'\\''")}' '${f.script.replaceAll("'", "'\\''")}'`;
  let tools, name, args;
  if (mode === 'workspace') { tools = await createWorkspaceTools(f.directory, { includeMutations: true }); name = 'project_exec'; args = { command }; }
  else if (mode === 'read-idempotent-command') {
    tools = [capabilities.commandTool({ toolName: 'fixture_command', command: process.execPath, args: [f.script], cwd: f.directory, permission: 'read', idempotent: true, timeoutMs: 10000, parameters: { type: 'object' } })]; name = 'fixture_command'; args = {};
  } else { tools = installs.createTools(project.id); name = 'capability_install'; args = { kind: 'skill', id: 'uncertain-skill', source: { type: 'git', repository: join(f.directory, 'repo') } }; }
  let requests = 0; const events = [];
  const options = { sessionId: 'uncertain-command', cwd: f.directory, stateDir: join(f.directory, 'sessions'), model, tools, onEvent: event => events.push(event), provider: async function* () {
    requests++; if (requests === 1) yield { type: 'tool_call', id: 'command-one', name, arguments: args };
    yield { type: 'done', stopReason: 'stop' };
  } };
  const session = await createSession(options); t.after(() => session.dispose());
  const running = session.prompt('Inspect the command outcome').then(() => null, error => error), pids = await f.started();
  kill(pids.guardian); const failure = await running;
  assert.equal(failure.code, 'uncertain_tool'); assert.equal(requests, 1); assert.ok(exists(pids.command));
  const snapshot = session.snapshot(); assert.equal(snapshot.recovery.uncertainTools.length, 1);
  assert.equal(snapshot.messages.filter(message => message.role === 'toolResult').length, 0);
  assert.ok(events.some(event => event.type === 'tool_execution_end' && event.uncertain && event.result.details.cleanupUncertain));
  const journal = (await readFile(snapshot.sessionFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(journal.some(record => record.type === 'tool_uncertain' && record.data.requiresResolution));
  assert.ok(!journal.some(record => record.type === 'tool_completed'));
  await session.dispose(); const reopened = await createSession({ ...options, sessionFile: snapshot.sessionFile }); t.after(() => reopened.dispose());
  await assert.rejects(reopened.resume(), { code: 'uncertain_tool' }); assert.equal(requests, 1);
  if (mode === 'capability-install') {
    assert.ok((await stat(pids.stagingDir)).isDirectory()); assert.equal(capabilities.configuration().installations.length, 0);
    const transactionFiles = await readdir(join(installs.rootDir, '.transactions'));
    const transaction = JSON.parse(await readFile(join(installs.rootDir, '.transactions', transactionFiles[0]), 'utf8'));
    assert.equal(transaction.status, 'needs_review'); assert.equal(transaction.failure.details.stagingDir, pids.stagingDir);
  }
});

test('an unresolved installation request stays blocked through service restart and retains its staging directory', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, true), store = new Store(join(f.directory, 'state.json'));
  const project = store.createProject({ name: 'Install only fixture', workspace: f.directory }).project;
  const service = new CapabilityInstallService(store, { installerOptions: { gitCommand: f.script } });
  const input = { kind: 'skill', id: 'uncertain-skill', source: { type: 'git', repository: join(f.directory, 'repo') } };
  const running = service.install(project.id, input, { requestId: 'same-request' }).then(() => null, error => error), pids = await f.started();
  kill(pids.guardian); const failure = await running;
  assert.equal(failure.outcome, 'unknown'); assert.equal(failure.details.cleanupUncertain, true); assert.equal(failure.details.stagingDir, pids.stagingDir);
  assert.ok((await stat(pids.stagingDir)).isDirectory());
  const reopened = new CapabilityInstallService(new Store(store.file), { installerOptions: { gitCommand: f.script } });
  await assert.rejects(reopened.install(project.id, input, { requestId: 'same-request' }), error => error.code === 'process_cleanup_uncertain' && error.outcome === 'unknown' && error.details.stagingDir === pids.stagingDir);
  assert.ok(exists(pids.command)); assert.ok((await stat(pids.stagingDir)).isDirectory());
});
