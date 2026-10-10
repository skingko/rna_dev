import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWorkspaceTools } from '../src/workspace-tools.mjs';
import { createExecOutputTool } from '../src/exec-output.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-exec-output-')), workspace = join(dir, 'work'), execLogDir = join(dir, 'session', 'exec');
  await mkdir(workspace); await mkdir(execLogDir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tools = await createWorkspaceTools(workspace, { includeMutations: true, execLogDir, maxOutputBytes: 256 });
  return { dir, workspace, execLogDir, exec: tools.find(t => t.name === 'project_exec'), reader: createExecOutputTool({ execLogDir }) };
}
const page = async (reader, args) => { const result = await reader.execute('read-capture', args); return { ...result, value: result.isError ? null : JSON.parse(result.content[0].text) }; };

test('first error in truncated command output is recovered by paging without rerunning the side effect', async t => {
  const f = await fixture(t);
  await writeFile(join(f.workspace, 'task.mjs'), 'import{appendFileSync}from"node:fs";appendFileSync("runs.txt","once\\n");console.log("FIRST_ERROR: missing column");console.log("tail filler ".repeat(500));process.exitCode=2;');
  const result = await f.exec.execute('real-command', { command: 'node task.mjs' });
  assert.equal(result.isError, true); assert.equal(result.details.exitCode, 2); assert.equal(result.details.truncated, true);
  assert.ok(!result.content[0].text.includes('FIRST_ERROR'));
  assert.match(result.content[0].text, new RegExp(result.details.outputId));
  const first = await page(f.reader, { outputId: result.details.outputId, maxBytes: 64 });
  assert.match(first.value.text, /FIRST_ERROR/); assert.equal(first.value.eof, false);
  let text = first.value.text, offset = first.value.nextOffset;
  while (true) { const next = (await page(f.reader, { outputId: result.details.outputId, offset, maxBytes: 256 })).value; text += next.text; offset = next.nextOffset; if (next.eof) break; }
  assert.equal(text, await readFile(result.details.fullOutputPath, 'utf8'));
  assert.equal(await readFile(join(f.workspace, 'runs.txt'), 'utf8'), 'once\n');
  // The ID is durable across handles but never accepted in another session.
  assert.match((await page(createExecOutputTool({ execLogDir: f.execLogDir }), { outputId: result.details.outputId })).value.text, /FIRST_ERROR/);
  const other = join(f.dir, 'other-session', 'exec'); await mkdir(other, { recursive: true });
  assert.equal((await page(createExecOutputTool({ execLogDir: other }), { outputId: result.details.outputId })).isError, true);
});

test('UTF-8 command captures can be reconstructed exactly from bounded byte pages', async t => {
  const f = await fixture(t), id = 'rna-exec-abcdef', directory = join(f.execLogDir, id); await mkdir(directory);
  const text = '中文😀/'.repeat(41); await writeFile(join(directory, 'output.log'), text);
  let reconstructed = '', offset = 0, pages = 0;
  while (true) {
    const value = (await page(f.reader, { outputId: id, offset, maxBytes: 32 })).value;
    assert.ok(Buffer.byteLength(value.text) <= 32); assert.ok(!value.text.includes('\ufffd'));
    reconstructed += value.text; pages++; assert.ok(pages < 100);
    if (value.eof) break; assert.ok(value.nextOffset > offset); offset = value.nextOffset;
  }
  assert.equal(reconstructed, text);
  assert.equal((await page(f.reader, { outputId: id, offset: Buffer.byteLength(text) })).value.eof, true);
});

test('capture IDs cannot read paths, symlinked directories or a replaced output file', async t => {
  const f = await fixture(t), id = 'rna-exec-abcdef', directory = join(f.execLogDir, id); await mkdir(directory);
  const secret = join(f.dir, 'secret'); await writeFile(secret, 'DO-NOT-READ');
  for (const outputId of ['../secret', secret, 'rna-exec-abcdef/../../secret', 'rna-exec-abcdef\0']) assert.equal((await page(f.reader, { outputId })).isError, true);
  await symlink(secret, join(directory, 'output.log'));
  const rejected = await page(f.reader, { outputId: id }); assert.equal(rejected.isError, true); assert.ok(!JSON.stringify(rejected).includes('DO-NOT-READ'));
  await rm(join(directory, 'output.log')); await rename(directory, directory + '-old'); await symlink(directory + '-old', directory);
  assert.equal((await page(f.reader, { outputId: id })).details.code, 'EXEC_OUTPUT_SCOPE_CHANGED');
});

test('non-regular command logs fail promptly and cancellation never opens a capture', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), id = 'rna-exec-abcdef', directory = join(f.execLogDir, id); await mkdir(directory);
  await promisify(execFile)('/usr/bin/mkfifo', [join(directory, 'output.log')]);
  assert.equal((await page(f.reader, { outputId: id })).details.code, 'EXEC_OUTPUT_NOT_FILE');
  const controller = new AbortController(); controller.abort(new Error('stop'));
  await assert.rejects(f.reader.execute('cancelled', { outputId: id }, controller.signal), /stop/);
});
