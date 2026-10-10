import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createSession } from '../src/session.mjs';
import { createWorkspaceTools } from '../src/workspace-tools.mjs';
import { openJournal } from '../src/journal.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 32000, maxOutputTokens: 1000 };
const hash = text => createHash('sha256').update(text).digest('hex');
const text = message => message.content?.filter(block => block.type === 'text').map(block => block.text).join('');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rna-file-recovery-')), root = join(directory, 'project'), stateDir = join(directory, 'state');
  await mkdir(root); const handles = [];
  t.after(async () => { await Promise.allSettled(handles.map(handle => handle.dispose())); await rm(directory, { recursive: true, force: true }); });
  const stats = { executions: 0, requests: 0, inputs: [] };
  const create = async (sessionFile, options = {}) => {
    const workspaceTools = await createWorkspaceTools(root, { includeMutations: true, ...options.workspace });
    const tools = workspaceTools.map(tool => ({ ...tool, execute() { stats.executions++; assert.fail('Recovery must never replay historical execution'); } }));
    const handle = await createSession({ sessionId: 'recovery-owner', projectId: 'recovery-project', cwd: root, stateDir, sessionFile, model, tools,
      provider: async function* (input) { stats.requests++; stats.inputs.push(input); yield { type: 'text_delta', delta: 'Current state acknowledged; no historical mutation replayed.' }; yield { type: 'done' }; }, ...options.session });
    handles.push(handle); return handle;
  };
  return { directory, root, stateDir, create, stats };
}
function seed(f, calls, checkpoints = {}, requiresResolution = false) {
  const journal = openJournal({ stateDir: f.stateDir, sessionId: 'recovery-owner', projectId: 'recovery-project' });
  journal.append('message', { message: { id: 'original-user', role: 'user', content: [{ type: 'text', text: 'Previous task' }] } });
  journal.append('message', { message: { id: 'original-assistant', role: 'assistant', content: calls.map(call => ({ type: 'toolCall', ...call })), stopReason: 'toolUse' } });
  for (const call of calls) {
    const callKey = `original-assistant/${call.id}`;
    journal.append('tool_intent', { callKey, toolCallId: call.id, toolName: call.name, arguments: call.arguments, effect: 'write', idempotent: false });
    if (checkpoints[call.id]) journal.append('tool_checkpoint', { callKey, checkpoint: checkpoints[call.id] });
    journal.append('tool_uncertain', { callKey, ...(requiresResolution ? { requiresResolution: true } : {}) });
  }
  const path = journal.file; journal.close(); return path;
}
const rows = async path => (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));

test('legacy interrupted edit observes current content, retires without historical success claims, and admits the new user exactly once', async t => {
  const f = await fixture(t), content = 'before and before'; await writeFile(join(f.root, 'document.txt'), content);
  const file = seed(f, [{ id: 'edit', name: 'project_edit', arguments: { path: 'document.txt', oldText: 'before', newText: 'after' } }]);
  const session = await f.create(file); await session.prompt('New user task');
  assert.equal(await readFile(join(f.root, 'document.txt'), 'utf8'), content); assert.equal(f.stats.executions, 0); assert.equal(f.stats.requests, 1);
  const messages = session.snapshot().messages, result = messages.find(message => message.role === 'toolResult');
  assert.equal(result.isError, true); assert.match(text(result), /historical outcome is not claimed/); assert.match(text(result), /without replay/);
  const evidence = (await rows(file)).find(row => row.type === 'tool_recovery_observation').data.evidence;
  assert.equal(evidence.currentHash, hash(content)); assert.equal(evidence.checkpointAvailable, false); assert.equal(evidence.desiredContentPresent, false); assert.equal(evidence.oldTextOccurrences, 2);
  assert.equal(messages.filter(message => message.role === 'user' && text(message) === 'New user task').length, 1);
  assert.ok(messages.indexOf(result) < messages.findIndex(message => text(message) === 'New user task'));
  await session.dispose(); const reopened = await f.create(file); assert.equal(reopened.snapshot().recovery.pendingTools, 0);
  await reopened.reconcileTools(); assert.equal((await rows(file)).filter(row => row.type === 'tool_completed').length, 1);
});

async function crashWrite(f, stage, content, toolName = 'project_write', registry = false) {
  // A write over an existing file names the version it replaces (an unobserved file is never overwritten).
  const existing = await readFile(join(f.root, 'document.txt'), 'utf8').catch(() => null), expectedHash = existing === null ? null : createHash('sha256').update(existing).digest('hex');
  const source = `import {createSession} from ${JSON.stringify(new URL('../src/session.mjs', import.meta.url).href)};
import {createWorkspaceTools} from ${JSON.stringify(new URL('../src/workspace-tools.mjs', import.meta.url).href)};
import {CapabilityRegistry} from ${JSON.stringify(new URL('../src/capabilities.mjs', import.meta.url).href)};
let tools=await createWorkspaceTools(${JSON.stringify(f.root)},{includeMutations:true});const write=tools.find(tool=>tool.name===${JSON.stringify(toolName)});
const execute=write.execute;write.execute=async(id,args,signal,update,execution)=>{
 const observer={checkpoint(value){execution.checkpoint(value);if(${JSON.stringify(stage)}==='checkpoint')process.kill(process.pid,'SIGKILL')}};
 const result=await execute(id,args,signal,update,observer);if(${JSON.stringify(stage)}==='mutated')process.kill(process.pid,'SIGKILL');return result;
};
if(${registry}){const registry=new CapabilityRegistry({tools});tools=(await registry.resolve({toolIds:tools.map(tool=>tool.id)})).tools;}
const session=await createSession({sessionId:'recovery-owner',projectId:'recovery-project',cwd:${JSON.stringify(f.root)},stateDir:${JSON.stringify(f.stateDir)},model:${JSON.stringify(model)},tools,provider:async function*(){yield {type:'tool_call',id:'write',name:${JSON.stringify(toolName)},arguments:${JSON.stringify(toolName === 'project_edit' ? { path: 'document.txt', oldText: 'old fixture', newText: content } : { path: 'document.txt', content, expectedHash })}};yield {type:'done'}}});
process.stdout.write(session.snapshot().sessionFile+'\\n');await session.prompt('Write fixture');`;
  const file = join(f.directory, 'crash-fixture.mjs'); await writeFile(file, source);
  const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const result = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Crash fixture timed out')); }, 10000); child.once('error', reject); child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); }); });
  assert.equal(stderr, ''); assert.equal(result.signal, 'SIGKILL'); assert.equal(result.code, null);
  return stdout.trim();
}

for (const scenario of ['before', 'after', 'changed', 'missing-file']) test(`real process crash before result: ${scenario} checkpoint state is reconciled without mutation replay`, async t => {
  const f = await fixture(t), before = 'old fixture', after = 'new fixture';
  if (scenario !== 'missing-file') await writeFile(join(f.root, 'document.txt'), before);
  const file = await crashWrite(f, ['before', 'missing-file'].includes(scenario) ? 'checkpoint' : 'mutated', after);
  const original = await rows(file); assert.equal(original.filter(row => row.type === 'tool_intent').length, 1); assert.equal(original.filter(row => row.type === 'tool_checkpoint').length, 1); assert.equal(original.filter(row => row.type === 'tool_completed').length, 0);
  if (scenario === 'changed') await writeFile(join(f.root, 'document.txt'), 'external newer contents');
  const observed = scenario === 'missing-file' ? null : await readFile(join(f.root, 'document.txt'), 'utf8');
  const session = await f.create(file), recovery = await session.reconcileTools();
  assert.equal(recovery.resolved.length, 1); assert.equal(recovery.unresolved.length, 0); assert.equal(f.stats.executions, 0); assert.equal(f.stats.requests, 0);
  const evidence = recovery.resolved[0].evidence;
  assert.equal(evidence.replayed, false); assert.equal(evidence.checkpointAvailable, true); assert.equal(evidence.currentHash, observed === null ? null : hash(observed));
  assert.equal(evidence.desiredContentPresent, scenario === 'after'); assert.equal(evidence.matchesBefore, ['before', 'missing-file'].includes(scenario));
  assert.equal(recovery.resolved[0].isError, scenario !== 'after');
  if (observed === null) await assert.rejects(stat(join(f.root, 'document.txt')), { code: 'ENOENT' });
  else assert.equal(await readFile(join(f.root, 'document.txt'), 'utf8'), observed);
  await session.prompt('Continue using current state'); assert.equal(f.stats.requests, 1); assert.equal(f.stats.executions, 0);
  await session.dispose(); const again = await f.create(file); assert.equal(again.snapshot().recovery.pendingTools, 0); assert.equal((await rows(file)).filter(row => row.type === 'tool_completed').length, 1);
});

test('checkpoint edit distinguishes a changed current file and refuses to claim an unobserved prior edit succeeded', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'document.txt'), 'external newer contents');
  const file = seed(f, [{ id: 'edit', name: 'project_edit', arguments: { path: 'document.txt', oldText: 'before', newText: 'after' } }], { edit: { kind: 'workspace-file-v1', path: 'document.txt', beforeHash: hash('before'), afterHash: hash('after') } });
  const session = await f.create(file), result = await session.reconcileTools();
  assert.equal(result.resolved[0].evidence.matchesBefore, false); assert.equal(result.resolved[0].evidence.desiredContentPresent, false); assert.equal(result.resolved[0].isError, true);
  assert.equal(await readFile(join(f.root, 'document.txt'), 'utf8'), 'external newer contents'); assert.equal(f.stats.executions, 0);
});

for (const toolName of ['project_write', 'project_edit']) for (const stage of ['checkpoint', 'mutated']) test(`registry ${toolName} preserves a durable full-file checkpoint across ${stage} crash`, async t => {
  const f = await fixture(t), before = 'prefix old fixture suffix', after = toolName === 'project_edit' ? 'prefix new fixture suffix' : 'new fixture';
  await writeFile(join(f.root, 'document.txt'), before);
  const file = await crashWrite(f, stage, 'new fixture', toolName, true), recorded = await rows(file);
  const checkpoint = recorded.find(row => row.type === 'tool_checkpoint').data.checkpoint;
  assert.equal(checkpoint.beforeHash, hash(before)); assert.equal(checkpoint.afterHash, hash(after));
  assert.equal(recorded.filter(row => row.type === 'tool_completed').length, 0);
  const current = stage === 'mutated' ? after : before;
  assert.equal(await readFile(join(f.root, 'document.txt'), 'utf8'), current);
  const handle = await f.create(file), result = await handle.reconcileTools();
  assert.equal(result.resolved.length, 1); assert.equal(result.resolved[0].evidence.currentHash, hash(current));
  assert.equal(result.resolved[0].isError, stage !== 'mutated'); assert.equal(f.stats.requests, 0); assert.equal(f.stats.executions, 0);
});

test('manual resolutions persist once without requesting a model or replaying an external command', async t => {
  const f = await fixture(t), statuses = ['completed', 'not-executed', 'abandoned'];
  const file = seed(f, statuses.map(status => ({ id: status, name: 'project_exec', arguments: { command: `never replay ${status}` } })), {}, true);
  const handle = await f.create(file), resolutions = Object.fromEntries(statuses.map(status => [`original-assistant/${status}`, { status, note: 'Operator checked process and workspace state.' }]));
  assert.deepEqual(handle.resolveTools(resolutions), { resolved: 3, unresolved: [] });
  assert.equal(f.stats.requests, 0); assert.equal(f.stats.executions, 0);
  const results = handle.snapshot().messages.filter(message => message.role === 'toolResult');
  assert.deepEqual(results.map(message => message.isError), [false, true, true]);
  assert.match(text(results[2]), /WITHOUT confirming its historical outcome/); assert.match(text(results[2]), /Do not repeat/);
  assert.deepEqual(handle.resolveTools(resolutions), { resolved: 0, unresolved: [] });
  await handle.dispose(); const reopened = await f.create(file);
  assert.deepEqual(reopened.resolveTools(resolutions), { resolved: 0, unresolved: [] });
  assert.equal((await rows(file)).filter(row => row.type === 'tool_manual_resolution').length, 3);
  assert.equal((await rows(file)).filter(row => row.type === 'tool_completed').length, 3);
  await reopened.prompt('New authorized task'); assert.equal(f.stats.requests, 1); assert.equal(f.stats.executions, 0);
});

test('manual resolution validates the entire map before any receipt and remains exclusive with active reconciliation', async t => {
  const f = await fixture(t), file = seed(f, [{ id: 'external', name: 'project_exec', arguments: { command: 'never replay' } }], {}, true), handle = await f.create(file);
  assert.throws(() => handle.resolveTools({ 'original-assistant/external': { status: 'abandoned' }, unknown: { status: 'completed' } }), { code: 'invalid_resolution' });
  assert.equal((await rows(file)).filter(row => row.type === 'tool_manual_resolution').length, 0);
  assert.equal(handle.snapshot().recovery.pendingTools, 1);
  const pending = handle.reconcileTools();
  assert.throws(() => handle.resolveTools({ 'original-assistant/external': { status: 'abandoned' } }), { code: 'busy' });
  await pending; assert.equal(f.stats.requests, 0);
});

test('file observations never resolve external command uncertainty or an explicit process-cleanup fence', async t => {
  for (const fenced of [false, true]) await t.test(fenced ? 'process-fence' : 'external-command', async t => {
    const f = await fixture(t); await writeFile(join(f.root, 'document.txt'), 'present');
    const calls = fenced ? [{ id: 'file', name: 'project_write', arguments: { path: 'document.txt', content: 'present' } }] : [{ id: 'file', name: 'project_write', arguments: { path: 'document.txt', content: 'present' } }, { id: 'external', name: 'project_exec', arguments: { command: 'never execute historical command' } }];
    const file = seed(f, calls, {}, fenced), session = await f.create(file);
    await assert.rejects(session.prompt('New task'), { code: 'recovery_required' }); await assert.rejects(session.resume(), { code: 'uncertain_tool' });
    assert.equal(session.snapshot().recovery.uncertainTools.length, 1); assert.equal(f.stats.requests, 0); assert.equal(f.stats.executions, 0);
    assert.equal((await rows(file)).filter(row => row.type === 'tool_recovery_observation').length, fenced ? 0 : 1);
  });
});

test('reconciliation rejects private, revoked, binary and symlink paths and never creates missing parent directories', async t => {
  const f = await fixture(t); await writeFile(join(f.root, '.env'), 'secret'); await writeFile(join(f.directory, 'outside'), 'outside'); await symlink(join(f.directory, 'outside'), join(f.root, 'linked')); await writeFile(join(f.root, 'binary'), Buffer.from([0, 1])); await mkdir(join(f.root, 'restricted')); await writeFile(join(f.root, 'restricted', 'data'), 'private');
  const names = ['.env', 'linked', 'binary', 'restricted/data'];
  const file = seed(f, names.map((path, index) => ({ id: `call-${index}`, name: 'project_write', arguments: { path, content: 'replacement' } }))), session = await f.create(file, { workspace: { deniedPaths: [join(f.root, 'restricted')] } });
  const result = await session.reconcileTools(); assert.equal(result.resolved.length, 0); assert.equal(result.unresolved.length, 4);
  assert.ok(result.unresolved.every(row => ['path_denied', 'invalid_file'].includes(row.code))); assert.equal(f.stats.executions, 0);
  const tools = await createWorkspaceTools(f.root, { includeMutations: true });
  const observation = await tools.find(tool => tool.name === 'project_write').reconcile({ arguments: { path: 'absent/dir/file', content: 'new' } });
  assert.equal(observation.evidence.currentHash, null); await assert.rejects(stat(join(f.root, 'absent')), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.directory, 'outside'), 'utf8'), 'outside'); assert.equal(await readFile(join(f.root, '.env'), 'utf8'), 'secret');
});

test('resume, prompt and another reconciliation cannot overlap a held observation; cancellation cannot publish a late result', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(); await writeFile(join(f.root, 'document.txt'), 'present');
  const file = seed(f, [{ id: 'file', name: 'project_write', arguments: { path: 'document.txt', content: 'present' } }]);
  const tools = await createWorkspaceTools(f.root, { includeMutations: true }), write = tools.find(tool => tool.name === 'project_write'), reconcile = write.reconcile; let hold = true;
  write.reconcile = async (input, signal) => { if (hold) { entered.resolve(); await release.promise; } return reconcile(input, signal); };
  write.execute = () => assert.fail('No old writes');
  const session = await f.create(file, { session: { tools } }), pending = session.resume(); await entered.promise;
  await assert.rejects(session.prompt('Overlapping user'), { code: 'busy' }); await assert.rejects(session.resume(), { code: 'busy' }); await assert.rejects(session.reconcileTools(), { code: 'busy' });
  const stopped = session.abort(); release.resolve(); await assert.rejects(pending, { code: 'aborted' }); await stopped;
  assert.equal(session.snapshot().recovery.pendingTools, 1); assert.equal((await rows(file)).filter(row => row.type === 'tool_completed').length, 0); assert.equal(f.stats.requests, 0);
  hold = false; await session.prompt('New task after cancellation'); assert.equal(f.stats.requests, 1); assert.equal(session.snapshot().recovery.pendingTools, 0);
  assert.equal(session.snapshot().messages.filter(message => message.role === 'user' && text(message) === 'New task after cancellation').length, 1);
});
