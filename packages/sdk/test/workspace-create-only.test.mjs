import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWorkspaceTools } from '../src/workspace-tools.mjs';
import { validateToolArguments } from '../src/capabilities.mjs';
import { prepareEvaluationWorkspace } from '../src/project-evaluation-workspace.mjs';
import { buildRequest } from '../src/providers.mjs';
import { createSession } from '../src/session.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'https://fixture.invalid/v1', contextWindow: 32000, maxOutputTokens: 1000 };
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rna-create-only-')), root = join(directory, 'workspace'); await mkdir(root);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tools = await createWorkspaceTools(root, { includeMutations: true, ...options });
  return { directory, root, tools, write: tools.find(tool => tool.name === 'project_write'), edit: tools.find(tool => tool.name === 'project_edit') };
}

test('createOnly writes a new file with an auditable checkpoint and refuses repeated identical or different writes', async t => {
  const f = await fixture(t), checkpoints = [], args = { path: 'nested/report.txt', content: 'original', createOnly: true };
  const result = await f.write.execute('create', args, undefined, undefined, { checkpoint: value => checkpoints.push(value) });
  assert.equal(result.isError, undefined); assert.equal(result.details.createOnly, true); assert.equal(result.details.beforeHash, null); assert.equal(result.details.hash, hash(args.content));
  assert.deepEqual(checkpoints, [{ kind: 'workspace-file-v1', path: 'nested/report.txt', beforeHash: null, afterHash: hash(args.content), createOnly: true }]);
  for (const content of ['original', 'replacement']) { const repeated = await f.write.execute('repeat', { ...args, content }); assert.equal(repeated.isError, true); assert.equal(repeated.details.code, 'conflict'); assert.equal(repeated.details.written, false); }
  assert.equal(await readFile(join(f.root, args.path), 'utf8'), 'original'); assert.deepEqual(await readdir(join(f.root, 'nested')), ['report.txt']);
});

test('createOnly is boolean, mutually exclusive with every expectedHash value, and does not coerce string null', async t => {
  const f = await fixture(t), valid = { path: 'new.txt', content: 'text', createOnly: true };
  assert.doesNotThrow(() => validateToolArguments(f.write.parameters, valid));
  const invalid = [ ...[null, hash('x'), 'null'].map(expectedHash => ({ ...valid, expectedHash })), ...['true', 'false', null, 1].map(createOnly => ({ ...valid, createOnly })), { path: 'new.txt', content: 'text', expectedHash: 'null' } ];
  for (const args of invalid) { assert.throws(() => validateToolArguments(f.write.parameters, args), { code: 'invalid_arguments' }); const result = await f.write.execute('invalid', args); assert.equal(result.details.code, 'invalid_arguments'); assert.equal(result.details.written, false); }
  const undefinedHash = await f.write.execute('own-undefined-hash', { ...valid, expectedHash: undefined }); assert.equal(undefinedHash.details.code, 'invalid_arguments');
  assert.throws(() => validateToolArguments(f.edit.parameters, { path: 'new.txt', oldText: 'old', newText: 'new', createOnly: true }), { code: 'invalid_arguments' });
  assert.deepEqual(await readdir(f.root), []);
});

test('false and omitted createOnly retain null and hash update behavior; without a hash an update needs the observed version', async t => {
  const f = await fixture(t);
  const first = await f.write.execute('legacy-create', { path: 'file.txt', content: 'first', expectedHash: null }); assert.equal(first.isError, undefined); assert.equal(first.details.createOnly, undefined);
  // An existing file is replaced without expectedHash only when it is the version this conversation last observed.
  const unobserved = await f.write.execute('false', { path: 'file.txt', content: 'second', createOnly: false }); assert.equal(unobserved.details.code, 'not_observed');
  const unconditional = await f.write.execute('false', { path: 'file.txt', content: 'second', createOnly: false }, undefined, undefined, { checkpoint() {}, observation: path => (path === 'file.txt' ? first.details.observation.hash : undefined) }); assert.equal(unconditional.isError, undefined);
  const guarded = await f.write.execute('hash', { path: 'file.txt', content: 'third', createOnly: false, expectedHash: hash('second') }); assert.equal(guarded.isError, undefined);
  const conflict = await f.write.execute('old-create', { path: 'file.txt', content: 'fourth', createOnly: false, expectedHash: null }); assert.equal(conflict.details.code, 'conflict');
  assert.equal(await readFile(join(f.root, 'file.txt'), 'utf8'), 'third');
});

test('independent registries serialize createOnly and an external creator cannot be overwritten', async t => {
  const f = await fixture(t), other = (await createWorkspaceTools(f.root, { includeMutations: true })).find(tool => tool.name === 'project_write');
  const results = await Promise.all([f.write.execute('a', { path: 'race.txt', content: 'a', createOnly: true }), other.execute('b', { path: 'race.txt', content: 'b', createOnly: true })]);
  assert.equal(results.filter(result => !result.isError).length, 1); assert.equal(results.filter(result => result.details.code === 'conflict').length, 1);
  const winner = await readFile(join(f.root, 'race.txt'), 'utf8'); assert.ok(['a', 'b'].includes(winner));
  const external = await f.write.execute('external-race', { path: 'external.txt', content: 'ours', createOnly: true }, undefined, undefined, { checkpoint() { writeFileSync(join(f.root, 'external.txt'), 'external', { flag: 'wx' }); } });
  assert.equal(external.details.code, 'conflict'); assert.equal(await readFile(join(f.root, 'external.txt'), 'utf8'), 'external');
  assert.deepEqual((await readdir(f.root)).sort(), ['external.txt', 'race.txt']);
});

test('createOnly retains abort, size, private and symlink protections without leaving temporary files', async t => {
  const f = await fixture(t, { maxFileBytes: 32 }); await writeFile(join(f.directory, 'outside.txt'), 'outside'); await symlink(join(f.directory, 'outside.txt'), join(f.root, 'alias'));
  for (const path of ['.env', 'alias', '../outside.txt']) { const result = await f.write.execute('deny', { path, content: 'bad', createOnly: true }); assert.equal(result.details.code, 'path_denied'); }
  const oversized = await f.write.execute('large', { path: 'too-large', content: 'x'.repeat(33), createOnly: true }); assert.equal(oversized.details.code, 'invalid_content');
  const before = new AbortController(); before.abort(); await assert.rejects(f.write.execute('abort', { path: 'before.txt', content: 'x', createOnly: true }, before.signal), { name: 'AbortError' });
  const during = new AbortController(); await assert.rejects(f.write.execute('abort-after-checkpoint', { path: 'during.txt', content: 'x', createOnly: true }, during.signal, undefined, { checkpoint() { during.abort(); } }), { name: 'AbortError' });
  assert.deepEqual(await readdir(f.root), ['alias']); assert.equal(await readFile(join(f.directory, 'outside.txt'), 'utf8'), 'outside');
});

for (const stage of ['checkpoint', 'mutated']) test(`uncertain createOnly ${stage} crash is reconciled by observation and never replayed`, async t => {
  const f = await fixture(t), stateDir = join(f.directory, 'state');
  const source = `import {createSession} from ${JSON.stringify(new URL('../src/session.mjs', import.meta.url).href)};
import {createWorkspaceTools} from ${JSON.stringify(new URL('../src/workspace-tools.mjs', import.meta.url).href)};
const tools=await createWorkspaceTools(${JSON.stringify(f.root)},{includeMutations:true});const write=tools.find(t=>t.name==='project_write'),execute=write.execute;
write.execute=async(id,args,signal,update,execution)=>{const result=await execute(id,args,signal,update,{checkpoint(value){execution.checkpoint(value);if(${JSON.stringify(stage)}==='checkpoint')process.kill(process.pid,'SIGKILL')}});if(${JSON.stringify(stage)}==='mutated')process.kill(process.pid,'SIGKILL');return result};
const session=await createSession({sessionId:'owner',projectId:'project',cwd:${JSON.stringify(f.root)},stateDir:${JSON.stringify(stateDir)},model:${JSON.stringify(model)},tools,provider:async function*(){yield {type:'tool_call',id:'create',name:'project_write',arguments:{path:'file.txt',content:'intended',createOnly:true}};yield {type:'done',stopReason:'toolUse'}}});console.log(session.snapshot().sessionFile);await session.prompt('Create fixture');`;
  const script = join(f.directory, 'crash.mjs'); await writeFile(script, source);
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }); assert.equal(exit.signal, 'SIGKILL', stderr);
  const file = stdout.trim(), rows = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); assert.equal(rows.filter(row => row.type === 'tool_completed').length, 0); assert.equal(rows.find(row => row.type === 'tool_checkpoint').data.checkpoint.createOnly, true);
  const tools = (await createWorkspaceTools(f.root, { includeMutations: true })).map(tool => ({ ...tool, execute() { assert.fail('Do not replay unknown creation'); } }));
  const session = await createSession({ sessionId: 'owner', projectId: 'project', stateDir, sessionFile: file, cwd: f.root, model, tools, provider: async function* () { assert.fail('Recovery is read-only'); } });
  try {
    const recovered = await session.reconcileTools(); assert.equal(recovered.resolved.length, 1); const evidence = recovered.resolved[0].evidence;
    assert.equal(evidence.createOnly, true); assert.equal(evidence.historicalCreation, 'not_claimed'); assert.equal(evidence.replayed, false); assert.equal(evidence.checkpointAvailable, true); assert.equal(evidence.desiredContentPresent, stage === 'mutated');
    if (stage === 'mutated') assert.equal(await readFile(join(f.root, 'file.txt'), 'utf8'), 'intended'); else await assert.rejects(readFile(join(f.root, 'file.txt')), { code: 'ENOENT' });
    assert.equal((await session.reconcileTools()).resolved.length, 0);
  } finally { await session.dispose(); }
});

test('createOnly recovery cannot promote an inconsistent checkpoint into proof of creation', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'file.txt'), 'external');
  const args = { path: 'file.txt', content: 'intended', createOnly: true };
  const recovered = await f.write.reconcile({ arguments: args, checkpoint: { kind: 'workspace-file-v1', path: 'file.txt', beforeHash: hash('previous'), afterHash: hash('external'), createOnly: true } });
  assert.equal(recovered.evidence.checkpointAvailable, false); assert.equal(recovered.evidence.desiredContentPresent, false); assert.equal(recovered.evidence.historicalCreation, 'not_claimed'); assert.equal(recovered.result.isError, true); assert.equal(await readFile(join(f.root, 'file.txt'), 'utf8'), 'external');
});

test('normal and evaluation write share the explicit new-file schema and wire preservation; edit has no new mode', async t => {
  const f = await fixture(t), tools = await prepareEvaluationWorkspace(f.root, { files: [], checks: [{ id: 'created', kind: 'file_exists', path: 'new.txt' }] }), evaluationWrite = tools.find(tool => tool.name === 'project_write');
  assert.deepEqual(evaluationWrite.parameters, f.write.parameters); assert.equal(evaluationWrite.description, f.write.description); assert.equal(f.edit.parameters.properties.createOnly, undefined);
  const wire = buildRequest({ model, messages: [], tools: [evaluationWrite] }).body.tools[0].function.parameters; assert.deepEqual(wire, f.write.parameters);
  const result = await evaluationWrite.execute('eval', { path: 'new.txt', content: 'new', createOnly: true }); assert.equal(result.isError, undefined); assert.equal(result.details.createOnly, true);
});
