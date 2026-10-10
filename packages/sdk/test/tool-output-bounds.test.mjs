import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { createWorkspaceTools } from '../src/workspace-tools.mjs';
import { outputTail, EXEC_TAIL_LINES } from '../src/workspace-exec.mjs';
import { createSpillReadTool } from '../src/tool-spill.mjs';
import { forgottenResultText, prepareContext, pruneMarker, PRUNE_MARKER } from '../src/context.mjs';

// Alignment 2026-10-05 A6, tool output. Each tool declares its spill policy (harness spill-policy exempts read; zcode
// gives read its own budget); project_exec keeps one truncation layer with one handle (pi truncate/OutputAccumulator);
// prune and forget markers say how a result can be had again (harness pruner marker, with the handle). Fake providers.
const model = { providerId: 'bounds-fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 400000, maxOutputTokens: 2000, reasoning: 'off' };
const quote = text => `'${String(text).replaceAll("'", "'\\''")}'`;
const node = script => `${quote(process.execPath)} -e ${quote(script)}`;
const text = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rna-output-bounds-')), root = join(directory, 'project'), stateDir = join(directory, 'state'); await mkdir(root);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tools = await createWorkspaceTools(root, { includeMutations: true, execLogDir: join(stateDir, 'exec') });
  return { directory, root, stateDir, tools, exec: tools.find(tool => tool.name === 'project_exec') };
}

test('project_read and project_exec bound their own output and are never spilled a second time; another tool still is', async t => {
  const f = await fixture(t), lines = Array.from({ length: 3000 }, (_, index) => `第${index + 1}行：雨下得很大，他推开铁门走了进去。`);
  await writeFile(join(f.root, 'novel.md'), lines.join('\n'));
  const big = { name: 'run_report', description: 'Report', parameters: { type: 'object', properties: {}, additionalProperties: false }, effect: 'read', execute: async () => Array.from({ length: 4000 }, (_, index) => `row ${index}`).join('\n') };
  const calls = [['project_read', { path: 'novel.md' }], ['project_exec', { command: node('for (let i = 0; i < 5000; i++) console.log("output line " + i)') }], ['run_report', {}]];
  let request = 0;
  const session = await createSession({ sessionId: 'bounds', projectId: 'bounds', cwd: f.root, stateDir: f.stateDir, model, tools: [...f.tools, big, createSpillReadTool({ dir: join(f.stateDir, 'spill') })], spillInlineBytes: 16 * 1024, autoCompaction: false, provider: async function* () {
    if (request++ === 0) { for (const [index, [name, args]] of calls.entries()) yield { type: 'tool_call', id: `c${index}`, name, arguments: args }; yield { type: 'done' }; return; }
    yield { type: 'text_delta', delta: 'done' }; yield { type: 'done', stopReason: 'stop' };
  } });
  t.after(() => session.dispose());
  await session.prompt('Look.');
  const [read, exec, report] = session.snapshot().messages.filter(message => message.role === 'toolResult');
  // The read page (about 50 KB, over the 16 KB spill threshold) arrives whole, its own line numbers intact.
  assert.ok(Buffer.byteLength(text(read)) > 16 * 1024); assert.doesNotMatch(text(read), /are omitted here/); assert.match(text(read), /^1\t第1行/m); assert.match(text(read), /Use offset=\d+ to continue/);
  // The command's tail is its only cut: no spill notice, one handle.
  assert.doesNotMatch(text(exec), /are omitted here|tool_output_read/); assert.match(text(exec), /^Capture ID: rna-exec-/m); assert.match(text(exec), /output line 4999\n?$/);
  assert.match(text(report), /are omitted here/, 'a tool that does not bound itself is still spilled');
  // Each result records how it can be had again once pruned or set aside.
  assert.deepEqual(read.recall, { rerun: true }); assert.equal(exec.recall.rerun, false); assert.equal(exec.recall.tool, 'project_exec_output'); assert.match(exec.recall.id, /^rna-exec-/);
  assert.equal(report.recall.tool, 'tool_output_read'); assert.match(report.recall.id, /^out-[a-f0-9]{12}$/);
});

test('project_exec shows one tail: within its byte and line budgets, on character and line boundaries, with the capture ID only', async t => {
  const f = await fixture(t);
  // 5000 short lines fit the byte budget but not the 2000-line cap (pi truncate.ts:11-12).
  const many = await f.exec.execute('many', { command: node('for (let i = 0; i < 5000; i++) console.log("x" + i)') });
  assert.equal(many.details.shownLines, EXEC_TAIL_LINES); assert.equal(many.details.truncated, true);
  assert.match(text(many), /Output truncated: showing the last 2000 lines/); assert.match(text(many), /\n\nx3000\n/); assert.doesNotMatch(text(many), /\nx2999\n/);
  // Long CJK output: at most 40 KiB shown, starting on a whole line, never a broken character.
  const wide = await f.exec.execute('wide', { command: node('for (let i = 0; i < 4000; i++) console.log(i + "：" + "雨".repeat(20))') });
  const body = text(wide).split('\n\n').slice(1).join('\n\n');
  assert.ok(Buffer.byteLength(body) <= 40 * 1024); assert.ok(!body.includes('�')); assert.match(body, /^\d+：雨{20}\n/); assert.match(body, /\n3999：雨{20}\n?$/);
  // The model sees no host path: the capture ID is the handle; the path stays in details for the UI.
  assert.ok(!text(wide).includes(f.directory), 'no absolute state path in the model-visible text'); assert.doesNotMatch(text(wide), /Full output:/);
  assert.ok(wide.details.fullOutputPath.startsWith(f.stateDir)); assert.match(text(wide), new RegExp(`Capture ID: ${wide.details.outputId} `));
  // One line longer than the budget keeps its end.
  assert.equal(outputTail(Buffer.from(`${'a'.repeat(100)}${'中'.repeat(100)}`), { maxBytes: 31 }).text, '中'.repeat(10));
  assert.deepEqual(outputTail(Buffer.from('a\nbb\nccc\n'), { maxBytes: 7 }), { text: 'bb\nccc\n', bytes: 7, lines: 2 }, 'already on a line');
  assert.deepEqual(outputTail(Buffer.from('a\nbb\nccc\n'), { maxBytes: 6 }), { text: 'ccc\n', bytes: 4, lines: 1 }, 'a cut line is dropped');
  assert.deepEqual(outputTail(Buffer.from('a\nbb\nccc'), { maxBytes: 100, maxLines: 2 }), { text: 'bb\nccc', bytes: 6, lines: 2 });
});

test('pruned and set-aside results say how to have them again: call a read again, never rerun an effect, keep a saved handle', () => {
  const read = { rerun: true }, exec = { rerun: false, tool: 'project_exec_output', id: 'rna-exec-abc123' }, spilled = { rerun: true, tool: 'tool_output_read', id: 'out-0123456789ab' }, write = { rerun: false };
  // Messages from before recall existed keep their wording, so an already projected history does not change.
  assert.equal(forgottenResultText('project_read'), '[Earlier project_read result set aside: later work superseded it. Call the tool again if you need it.]');
  assert.equal(forgottenResultText('project_read', read), forgottenResultText('project_read')); assert.equal(pruneMarker(undefined), PRUNE_MARKER); assert.equal(pruneMarker(read), PRUNE_MARKER);
  assert.match(forgottenResultText('project_exec', exec), /Its effect already happened; do not run it again\. Its complete output is saved: read it with project_exec_output \{"outputId": "rna-exec-abc123"\}/);
  assert.doesNotMatch(forgottenResultText('project_exec', exec), /Call the tool again/);
  assert.match(forgottenResultText('project_write', write), /do not run it again\. Read the current files/);
  assert.match(pruneMarker(spilled), /tool_output_read \{"id": "out-0123456789ab"\}/); assert.match(pruneMarker(exec), /project_exec_output/); assert.match(pruneMarker(write), /do not run it again/);
  // In the request: a forgotten exec result and a pruned spilled result keep their handles.
  const long = `${'head '.repeat(2000)}MIDDLE${'tail '.repeat(2000)}`;
  const messages = [
    { id: 'u', role: 'user', source: 'user', content: [{ type: 'text', text: 'go' }] },
    { id: 'a', role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'project_exec', arguments: { command: 'python rewrite.py' } }, { type: 'toolCall', id: 'c2', name: 'run_report', arguments: {} }] },
    { id: 'r1', role: 'toolResult', toolCallId: 'c1', toolName: 'project_exec', content: [{ type: 'text', text: long }], recall: exec },
    { id: 'r2', role: 'toolResult', toolCallId: 'c2', toolName: 'run_report', content: [{ type: 'text', text: long }], recall: spilled },
  ];
  const projected = prepareContext({ model, messages, forgotten: new Map([['r1', { toolName: 'project_exec' }]]), pruned: new Map([['r2', { head: 4096, tail: 1024 }]]) }).messages;
  assert.equal(text(projected.find(message => message.id === 'r1')), forgottenResultText('project_exec', exec));
  const pruned = text(projected.find(message => message.id === 'r2'));
  assert.ok(pruned.includes(pruneMarker(spilled))); assert.ok(!pruned.includes('MIDDLE'));
});
