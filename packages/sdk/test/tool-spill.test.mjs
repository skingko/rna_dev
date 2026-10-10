import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { spillText, spillId, createSpillReadTool, SPILL_ID } from '../src/tool-spill.mjs';

// Plan 2026-09-30 §4.3: oversized tool output keeps head and tail in context and
// is read back by line or pattern; nothing is lost and nothing is rerun.
const model = { providerId: 'test', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 32000, maxOutputTokens: 1000, reasoning: 'off' };
const log = count => Array.from({ length: count }, (_, index) => `line ${index + 1}: ${index === 1234 ? 'AssertionError: expected f(50) got 100' : 'ok '.repeat(10)}`).join('\n');

test('spillText keeps ordered head and tail, a pointer, and the whole text on disk', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-spill-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const text = log(3000), id = spillId('s/call');
  assert.match(id, SPILL_ID);
  assert.equal(spillText('short', { dir, id, inlineBytes: 1024 }), null);
  const result = spillText(text, { dir, id, inlineBytes: 8192 });
  assert.ok(Buffer.byteLength(result.text) < 8192 + 600);
  assert.ok(result.text.startsWith('line 1: '));
  assert.ok(result.text.endsWith('line 3000: ' + 'ok '.repeat(10)));
  const [from, to] = result.spill.omitted;
  assert.match(result.text, new RegExp(`Lines ${from}-${to} of 3000 are omitted`));
  assert.equal(await readFile(join(dir, `${id}.txt`), 'utf8'), text);
  const read = createSpillReadTool({ dir });
  const page = await read.execute('c', { id, offset: 1234, limit: 2 });
  assert.equal(page.content[0].text, `1234\t${text.split('\n')[1233]}\n1235\tline 1235: AssertionError: expected f(50) got 100\n\nShowing lines 1234-1235 of 3000. Use offset=1236 to continue.`);
  const found = await read.execute('c', { id, pattern: 'assertionerror', context: 1 });
  assert.match(found.content[0].text, /^1234-\t/); assert.match(found.content[0].text, /\n1235:\tline 1235: AssertionError/);
  assert.deepEqual(found.details.matches, [1235]);
  const literal = await read.execute('c', { id, pattern: 'f(50' });
  assert.match(literal.content[0].text, /1 matching lines of 3000/);
  assert.equal((await read.execute('c', { id: 'out-000000000000' })).isError, true);
  assert.equal((await read.execute('c', { id, offset: 5000 })).isError, true);
});

test('a session spills an oversized tool result; the model reads the omitted part back', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-spill-session-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const stateDir = join(dir, 'state'), requests = [];
  const big = log(4000), reader = createSpillReadTool({ dir: join(stateDir, 'spill') });
  const tools = [{ name: 'run_tests', description: 'Run tests', parameters: { type: 'object', properties: {}, additionalProperties: false }, effect: 'read', execute: async () => big }, reader];
  let spilled;
  const session = await createSession({ sessionId: 'spill', projectId: 'p', cwd: dir, stateDir, model, tools, spillInlineBytes: 16 * 1024, provider: async function* (request) {
    requests.push(request);
    if (requests.length === 1) { yield { type: 'tool_call', id: 't1', name: 'run_tests', arguments: {} }; yield { type: 'done' }; return; }
    if (requests.length === 2) {
      const result = request.messages.find(message => message.role === 'toolResult');
      const content = result.content.map(part => part.text).join('');
      assert.ok(Buffer.byteLength(content) < 16 * 1024 + 600, 'only head, pointer and tail reach the model');
      spilled = /saved as "(out-[a-f0-9]{12})"/.exec(content)[1];
      yield { type: 'tool_call', id: 't2', name: 'tool_output_read', arguments: { id: spilled, pattern: 'AssertionError' } }; yield { type: 'done' }; return;
    }
    const read = request.messages.filter(message => message.role === 'toolResult').at(-1);
    assert.match(read.content[0].text, /1235:\tline 1235: AssertionError/);
    yield { type: 'text_delta', delta: 'Found the failure on line 1235.' }; yield { type: 'done' };
  } });
  t.after(() => session.dispose());
  await session.prompt('run the tests');
  assert.equal(requests.length, 3);
  const completed = session.snapshot().messages.find(message => message.role === 'toolResult' && message.toolName === 'run_tests');
  assert.ok(completed);
});
