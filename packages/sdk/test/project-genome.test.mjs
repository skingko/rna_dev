import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectGenomeFixture } from './fixtures/project-genome.mjs';
import { createHash } from 'node:crypto';
import { validateProjectGenome, smokeProjectGenome, createGenomeTools, runGenomeScript, genomeToolName, genomeNamespace } from '../src/project-genome.mjs';
import * as sdk from '../src/index.mjs';

async function fixture(t) { const root = await mkdtemp(join(tmpdir(), 'rna-genome-test-')); t.after(() => rm(root, { recursive: true, force: true })); const workspace = join(root, 'workspace'); await mkdir(workspace); return { root, workspace }; }
test('genome schemas require real skills, contracts for any generated scripts and at least three explicit frozen evaluation cases', () => {
  assert.deepEqual(validateProjectGenome(projectGenomeFixture()), projectGenomeFixture());
  const empty = projectGenomeFixture(); empty.tools = []; assert.throws(() => validateProjectGenome(empty));
  const escape = projectGenomeFixture(); escape.skills[0].resources[0].path = '../secret'; assert.throws(() => validateProjectGenome(escape));
  const missing = projectGenomeFixture(); missing.evaluationSuite.cases[0].requiredToolIds = ['not_generated']; assert.throws(() => validateProjectGenome(missing));
  const weak = projectGenomeFixture(); weak.evaluationSuite.thresholds.minImprovement = 0; assert.throws(() => validateProjectGenome(weak));
});
test('generated scripts really execute in isolated child processes and smoke results compare actual JSON', async () => {
  const result = await smokeProjectGenome(projectGenomeFixture()); assert.equal(result.passed, true); assert.equal(result.executed, true); assert.deepEqual(result.results[0].actual, { doubled: 4 });
  const invalid = projectGenomeFixture(); invalid.tools[0].script = 'return { doubled: 99 };'; assert.equal((await smokeProjectGenome(invalid)).passed, false);
});
test('read permission cannot write; allowed writes use the scoped API and namespace names remain stable', async t => {
  const { workspace } = await fixture(t), genome = projectGenomeFixture(), tool = genome.tools[0];
  const denied = { ...tool, script: 'await api.writeFile("data.txt", "unsafe"); return input;' };
  await assert.rejects(runGenomeScript(denied, { value: 2 }, { workspace }), /Read-only/);
  await assert.rejects(readFile(join(workspace, 'data.txt')), { code: 'ENOENT' });
  const allowed = { ...denied, permission: 'write' }; assert.deepEqual((await runGenomeScript(allowed, { value: 2 }, { workspace })).value, { value: 2 }); assert.equal(await readFile(join(workspace, 'data.txt'), 'utf8'), 'unsafe');
  const tools = createGenomeTools(genome, { namespace: 'project:version', workspace }); assert.equal(tools[0].id, genomeToolName('project:version', tool.id)); assert.notEqual(tools[0].id, genomeToolName('other:version', tool.id));
});
test('generated API rejects parent traversal, symlinks, host-private files and caller denied paths in reads, writes and listings', async t => {
  const { root, workspace } = await fixture(t), tool = { ...projectGenomeFixture().tools[0], permission: 'write' };
  await writeFile(join(root, 'outside.txt'), 'outside-secret'); await writeFile(join(workspace, 'daemon.secrets'), 'daemon-secret'); await writeFile(join(workspace, 'protected.json'), 'private-secret'); await symlink(join(root, 'outside.txt'), join(workspace, 'link.txt'));
  for (const path of ['../outside.txt', 'link.txt', 'daemon.secrets', 'protected.json']) {
    await assert.rejects(runGenomeScript({ ...tool, script: `return await api.readFile(${JSON.stringify(path)});` }, { value: 2 }, { workspace, deniedPaths: [join(workspace, 'protected.json')] }));
    await assert.rejects(runGenomeScript({ ...tool, script: `await api.writeFile(${JSON.stringify(path)}, "overwritten"); return true;` }, { value: 2 }, { workspace, deniedPaths: [join(workspace, 'protected.json')] }));
  }
  const listed = await runGenomeScript({ ...tool, script: 'return await api.listFiles();' }, { value: 2 }, { workspace, deniedPaths: [join(workspace, 'protected.json')] }); assert.deepEqual(listed.value, []);
  assert.equal(await readFile(join(root, 'outside.txt'), 'utf8'), 'outside-secret'); assert.equal(await readFile(join(workspace, 'protected.json'), 'utf8'), 'private-secret');
});
test('generated workers protect missing aliased deny roots without broadening their filesystem permissions', async t => {
  const { root, workspace } = await fixture(t), alias = join(root, 'workspace-alias'), tool = { ...projectGenomeFixture().tools[0], permission: 'write' }; await symlink(workspace, alias);
  const options = { workspace, deniedPaths: [join(alias, 'future-private', 'nested'), join(root, 'host-state-not-in-workspace')] };
  await assert.rejects(runGenomeScript({ ...tool, script: 'await api.writeFile("future-private/nested/journal.jsonl", "must-not-write"); return true;' }, { value: 2 }, options), /private/);
  await assert.rejects(stat(join(workspace, 'future-private')), { code: 'ENOENT' });
  const ordinary = await runGenomeScript({ ...tool, script: 'await api.writeFile("public.txt", "allowed"); return await api.readFile("public.txt");' }, { value: 2 }, options); assert.equal(ordinary.value, 'allowed');
  await assert.rejects(runGenomeScript({ ...tool, script: 'return await api.readFile("public.txt");' }, { value: 2 }, { workspace, deniedPaths: [root] }), /private/);
});
test('script globals expose no provider credentials or ambient module/network/process API, and hangs are stopped', async t => {
  const { workspace } = await fixture(t), tool = projectGenomeFixture().tools[0];
  process.env.RNA_GENOME_TEST_SECRET = 'must-not-cross-process'; t.after(() => { delete process.env.RNA_GENOME_TEST_SECRET; });
  const globals = await runGenomeScript({ ...tool, script: 'return [typeof process, typeof require, typeof fetch, typeof __bridge];' }, { value: 2 }, { workspace }); assert.deepEqual(globals.value, ['undefined', 'undefined', 'undefined', 'undefined']);
  await assert.rejects(runGenomeScript({ ...tool, script: 'return api.readFile.constructor("return process")();' }, { value: 2 }, { workspace }), /Code generation/);
  await assert.rejects(runGenomeScript({ ...tool, script: 'while (true) {}' }, { value: 2 }, { workspace, timeoutMs: 150 }), { code: 'script_timeout' });
  const abort = new AbortController(); const pending = runGenomeScript({ ...tool, script: 'await new Promise(() => {});' }, { value: 2 }, { workspace, signal: abort.signal }); abort.abort(); await assert.rejects(pending, { code: 'aborted' });
});

test('generated file API returns text, write receipts and deterministic immediate names with strict call limits', async t => {
  const { workspace } = await fixture(t), tool = { ...projectGenomeFixture().tools[0], permission: 'write' };
  await mkdir(join(workspace, 'nested')); await writeFile(join(workspace, 'nested', 'hidden-child.txt'), 'child');
  await writeFile(join(workspace, 'z.txt'), 'last'); await writeFile(join(workspace, '.env'), 'private');
  const result = await runGenomeScript({ ...tool, script: 'const written = await api.writeFile("a.txt", "中文 text"); return { written, text: await api.readFile("a.txt"), names: await api.listFiles() };' }, { value: 2 }, { workspace });
  assert.deepEqual(result.value, { written: { written: true }, text: '中文 text', names: ['a.txt', 'nested', 'z.txt'] });
  await assert.rejects(runGenomeScript({ ...tool, script: 'return await Promise.all(Array.from({length:51}, () => api.listFiles()));' }, { value: 2 }, { workspace }), /file operation limit/);
  await assert.rejects(runGenomeScript({ ...tool, script: 'for(let i=0;i<50;i++) { try { await api.readFile("missing.txt"); } catch {} } return await api.listFiles();' }, { value: 2 }, { workspace }), /file operation limit/);
});

test('EVO-3: generated tool names come from the project and the local id, the same for every generation of the project', () => {
  assert.equal(genomeToolName(genomeNamespace('p'), 'x'), `gen_${createHash('sha256').update('p').digest('hex').slice(0, 8)}_x`);
  assert.equal(sdk.genomeNamespace, genomeNamespace, 'exported from the SDK entry');
  const first = projectGenomeFixture(), second = structuredClone(first);
  second.systemPrompt = `${second.systemPrompt}\nA later generation.`; second.tools[0].description = 'A revised description of the same tool.';
  second.skills[0].instructions = `${second.skills[0].instructions}\nOne more rule.`;
  const names = genome => createGenomeTools(genome, { namespace: genomeNamespace('project-one'), workspace: tmpdir() }).map(tool => tool.name);
  assert.deepEqual(names(first), names(second), 'two genomes of one project declare the same names');
  assert.notDeepEqual(names(first), createGenomeTools(first, { namespace: genomeNamespace('project-two'), workspace: tmpdir() }).map(tool => tool.name), 'another project names its tools apart');
  const [a] = createGenomeTools(first, { namespace: genomeNamespace('project-one'), workspace: tmpdir() }), [b] = createGenomeTools(second, { namespace: genomeNamespace('project-one'), workspace: tmpdir() });
  assert.equal(a.name, b.name); assert.notEqual(a.description, b.description, 'a changed description still changes the declaration');
});
