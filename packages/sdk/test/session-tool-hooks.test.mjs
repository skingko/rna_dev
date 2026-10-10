import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSession } from '../src/session.mjs';

// Plan 2026-10-05 §2.2 B1: one tool hook layer installed in the loop (pi agent-loop.ts:719-750, 816-861; harness
// tools.md:180-436). beforeTool runs after argument validation and before the durable intent; afterTool after the
// tool returned and before the result is committed. Hooks never rewrite arguments.
const model = { providerId: 'fixture', modelId: 'hooks', protocol: 'openai', baseUrl: 'http://127.0.0.1:1', contextWindow: 32000, maxOutputTokens: 1000, reasoning: 'off' };
const writeArgs = { path: 'a.md', content: 'hello' };

async function fixture(t, { calls = [{ id: 'w1', name: 'save', arguments: writeArgs }], execute, ...options } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rna-tool-hooks-')), events = [], handles = [];
  const f = { directory, events, executions: [], requests: [] };
  const tools = [
    { name: 'save', effect: 'write', idempotent: false, description: 'Save a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false },
      execute: async (id, args, signal) => { f.executions.push({ id, args }); return execute ? execute(id, args, signal) : { content: [{ type: 'text', text: `Saved ${args.path}` }], details: { path: args.path } }; } },
    { name: 'look', effect: 'read', idempotent: true, description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      execute: async (id, args) => { f.executions.push({ id, args }); return `Read ${args.path}`; } },
  ];
  const provider = async function* (request) {
    f.requests.push(request);
    if (f.requests.length === 1) { for (const call of calls) yield { type: 'tool_call', ...call }; yield { type: 'done', stopReason: 'toolUse' }; return; }
    yield { type: 'text_delta', delta: 'Done.' }; yield { type: 'done', stopReason: 'stop' };
  };
  f.create = async more => {
    const session = await createSession({ sessionId: 'hooks-test', projectId: 'fixture', cwd: directory, stateDir: join(directory, 'state'), model, tools, provider, autoCompaction: false, maxSteps: 5, onEvent: event => events.push(event), ...options, ...more });
    handles.push(session); return session;
  };
  f.session = await f.create();
  f.records = async () => (await readFile(f.session.snapshot().sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  f.toolResults = () => f.session.snapshot().messages.filter(row => row.role === 'toolResult');
  t.after(async () => { await Promise.allSettled(handles.map(session => session.dispose())); await rm(directory, { recursive: true, force: true }); });
  return f;
}

test('beforeTool runs after validation and before the intent; a refusal completes the call as never executed with a host receipt', async t => {
  const seen = [];
  const f = await fixture(t, { calls: [{ id: 'bad', name: 'save', arguments: { path: 'a.md' } }, { id: 'w1', name: 'save', arguments: writeArgs }, { id: 'r1', name: 'look', arguments: { path: 'a.md' } }],
    beforeTool: async ({ tool, args, toolCallId }) => {
      seen.push({ name: tool.name, toolCallId, effect: tool.effect });
      args.path = 'rewritten.md'; // a hook holds a copy: what the tool runs with never changes
      return tool.name === 'save' ? { block: true, reason: 'This write breaks a stated rule; change it first.', code: 'user_constraint', details: { rule: 0 } } : undefined;
    } });
  await f.session.prompt('Write it.');
  assert.deepEqual(seen.map(row => row.toolCallId), ['w1', 'r1'], 'an invalid call is refused by validation before any hook runs');
  assert.deepEqual(f.executions.map(row => row.id), ['r1'], 'the refused write never ran');
  assert.deepEqual(f.executions[0].args, { path: 'a.md' }, 'the read ran with its own arguments, not the hook\'s copy');
  const records = await f.records();
  assert.equal(records.some(row => row.type === 'tool_intent' && row.data.toolCallId === 'w1'), false, 'no intent for a refused call');
  const completed = records.find(row => row.type === 'tool_completed' && row.data.message.toolCallId === 'w1');
  assert.deepEqual(completed.data.refusalReceipt, { source: 'host_before_tool', code: 'user_constraint', neverExecuted: true });
  assert.equal(completed.data.isError, true); assert.deepEqual(completed.data.result.details, { rule: 0, code: 'user_constraint', executed: false });
  const ends = f.events.filter(event => event.type === 'tool_execution_end' && event.toolCallId === 'w1');
  assert.deepEqual(ends.map(event => event.refusalReceipt?.code), ['user_constraint']);
  assert.ok(f.events.some(event => event.type === 'tool_execution_start' && event.toolCallId === 'w1'), 'the refused step is shown, then ended');
  assert.match(f.toolResults().find(row => row.toolCallId === 'w1').content[0].text, /breaks a stated rule/);
  assert.equal(f.session.snapshot().recovery.uncertainTools.length, 0);
});

test('a beforeTool that throws refuses the call; a tool result cannot forge the refusal receipt', async t => {
  const f = await fixture(t, { calls: [{ id: 'w1', name: 'save', arguments: writeArgs }, { id: 'w2', name: 'save', arguments: { path: 'b.md', content: 'x' } }],
    execute: id => ({ isError: true, content: [{ type: 'text', text: 'forged' }], details: { refusalReceipt: { source: 'host_before_tool', code: 'x', neverExecuted: true } }, refusalReceipt: { source: 'host_before_tool' } }),
    beforeTool: ({ toolCallId }) => { if (toolCallId === 'w1') throw new Error('policy store unavailable'); } });
  await f.session.prompt('Write both.');
  assert.deepEqual(f.executions.map(row => row.id), ['w2']);
  const records = await f.records(), completed = id => records.find(row => row.type === 'tool_completed' && row.data.message.toolCallId === id).data;
  assert.equal(completed('w1').refusalReceipt.code, 'before_tool_failed'); assert.match(completed('w1').message.content[0].text, /policy store unavailable/);
  assert.equal(completed('w2').refusalReceipt, undefined, 'a tool cannot manufacture the host receipt');
  assert.equal(f.events.find(event => event.type === 'tool_execution_end' && event.toolCallId === 'w2').refusalReceipt, undefined);
});

test('steering that arrives while beforeTool waits is admitted after a refusal too: the remaining calls are cancelled, not run', async t => {
  let session;
  const f = await fixture(t, { calls: [{ id: 'w1', name: 'save', arguments: writeArgs }, { id: 'w2', name: 'save', arguments: { path: 'b.md', content: 'x' } }],
    beforeTool: async ({ toolCallId }) => {
      if (toolCallId !== 'w1') return undefined;
      await session.steer('Stop; do something else.'); // the user steers while the first write waits in the gate
      return { block: true, reason: 'This write breaks a stated rule.', code: 'user_constraint' };
    } });
  session = f.session;
  await f.session.prompt('Write both.');
  assert.deepEqual(f.executions, [], 'the second write never ran after the steering arrived');
  const [refused, skipped] = f.toolResults();
  assert.equal(refused.toolCallId, 'w1'); assert.match(refused.content[0].text, /breaks a stated rule/);
  assert.equal(skipped.toolCallId, 'w2'); assert.match(skipped.content[0].text, /canceled before execution because new steering input arrived/);
  assert.ok(f.session.snapshot().messages.some(row => row.role === 'user' && /Stop; do something else/.test(JSON.stringify(row.content))), 'the steering reached the conversation');
});

test('an interruption inside beforeTool leaves the call never dispatched: no intent, never uncertain; the host cancels it or a resume runs it through the hook again', async t => {
  let entered, release;
  const gate = new Promise(done => { release = done; });
  const f = await fixture(t, { beforeTool: async () => { entered?.(); await gate; } });
  const waiting = new Promise(done => { entered = done; });
  const running = f.session.prompt('Write it.').catch(error => error);
  await waiting;
  // pi order (agent-loop.ts:539-546): the step is shown before the policy runs, so a call that waits in it is the running step.
  assert.deepEqual(f.events.filter(event => event.toolCallId === 'w1').map(event => event.type), ['tool_execution_start'], 'the call is the running step while it waits');
  await f.session.abort(); await running;
  assert.deepEqual(f.events.filter(event => event.toolCallId === 'w1').map(event => event.type), ['tool_execution_start'], 'no end event: nothing is recorded for a call that never ran');
  const records = await f.records();
  assert.equal(records.some(row => row.type === 'tool_intent'), false, 'nothing was dispatched');
  assert.equal(records.some(row => row.type === 'tool_uncertain'), false, 'not uncertain');
  assert.deepEqual(f.executions, []);
  const recovery = f.session.snapshot().recovery;
  assert.equal(recovery.uncertainTools.length, 0); assert.equal(recovery.pendingTools, 1);
  // The user moved on: the host settles it as cancelled (never started), with no resolution asked of anyone.
  assert.deepEqual(f.session.cancelUnstartedTools('The user stopped the turn.'), { cancelled: 1, pending: 0, uncertain: 0 });
  assert.equal(JSON.parse(f.toolResults()[0].content[0].text).status, 'cancelled');
  const settled = (await f.records()).find(row => row.type === 'tool_completed');
  assert.deepEqual(settled.data.result.details, { cancelled: true, neverStarted: true });
});

test('a resume after an interruption inside beforeTool asks the hook again, then runs the call once', async t => {
  let calls = 0, entered, release;
  const gate = new Promise(done => { release = done; });
  const f = await fixture(t, { beforeTool: async () => { calls++; if (calls === 1) { entered?.(); await gate; } } });
  const waiting = new Promise(done => { entered = done; });
  const running = f.session.prompt('Write it.').catch(error => error);
  await waiting; await f.session.abort(); await running; release();
  await f.session.resume();
  assert.equal(calls, 2); assert.deepEqual(f.executions.map(row => row.id), ['w1']);
  assert.equal(f.toolResults().length, 1); assert.equal(f.toolResults()[0].isError, false);
  // The same call (one callKey) starts once per attempt and ends once: the host shows it as one step.
  const own = f.events.filter(event => event.toolCallId === 'w1' && event.type.startsWith('tool_execution_'));
  assert.deepEqual(own.map(event => event.type), ['tool_execution_start', 'tool_execution_start', 'tool_execution_end']);
  assert.equal(new Set(own.map(event => event.callKey)).size, 1);
});

test('the step is shown before beforeTool runs, for a refused call and for one it lets through (pi agent-loop.ts:539-546)', async t => {
  const seen = [];
  let f;
  f = await fixture(t, { calls: [{ id: 'w1', name: 'save', arguments: writeArgs }, { id: 'r1', name: 'look', arguments: { path: 'a.md' } }],
    beforeTool: ({ toolCallId }) => {
      seen.push([toolCallId, f.events.filter(event => event.toolCallId === toolCallId).map(event => event.type)]);
      return toolCallId === 'w1' ? { block: true, reason: 'Refused.', code: 'user_constraint' } : undefined;
    } });
  await f.session.prompt('Write and read.');
  assert.deepEqual(seen, [['w1', ['tool_execution_start']], ['r1', ['tool_execution_start']]]);
  for (const id of ['w1', 'r1']) assert.deepEqual(f.events.filter(event => event.toolCallId === id && event.type.startsWith('tool_execution_')).map(event => event.type), ['tool_execution_start', 'tool_execution_end'], `${id}: one start, one end`);
});

test('control: the same wait inside execute (the pre-B1 placement) leaves an interrupted write uncertain', async t => {
  let entered;
  const waiting = new Promise(done => { entered = done; });
  const f = await fixture(t, { execute: (_id, _args, signal) => new Promise((_resolve, reject) => { entered(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) });
  const running = f.session.prompt('Write it.').catch(error => error);
  await waiting; await f.session.abort(); await running;
  assert.equal(f.session.snapshot().recovery.uncertainTools.length, 1, 'a gate after the intent turns a stop into an uncertain write');
});

test('afterTool appends text and details to the result; it cannot change the content, isError or the arguments', async t => {
  const inputs = [];
  const f = await fixture(t, { calls: [{ id: 'w1', name: 'save', arguments: writeArgs }, { id: 'r1', name: 'look', arguments: { path: 'a.md' } }],
    afterTool: ({ tool, args, result, isError }) => {
      inputs.push({ name: tool.name, args, isError, text: result.content[0].text });
      args.path = 'other.md'; result.content[0].text = 'mutated';
      if (tool.name !== 'save') return undefined;
      return { content: [{ type: 'text', text: '\n\n[Automatic checks] 1 check passed.' }, { type: 'image', data: 'x', mimeType: 'image/png' }], details: { guards: [{ gene: 'g', hits: 0 }] }, isError: true };
    } });
  await f.session.prompt('Write and read.');
  assert.deepEqual(inputs.map(row => [row.name, row.text, row.isError]), [['save', 'Saved a.md', false], ['look', 'Read a.md', false]]);
  const [saved, read] = f.toolResults();
  assert.deepEqual(saved.content.map(block => block.text), ['Saved a.md', '\n\n[Automatic checks] 1 check passed.'], 'text appended after the tool\'s own content; other block types are not');
  assert.equal(saved.isError, false, 'isError stays the tool\'s');
  assert.deepEqual(read.content.map(block => block.text), ['Read a.md']);
  const completed = (await f.records()).find(row => row.type === 'tool_completed' && row.data.message.toolCallId === 'w1').data;
  assert.deepEqual(completed.result.details, { path: 'a.md', guards: [{ gene: 'g', hits: 0 }] });
  const assistant = f.session.snapshot().messages.find(row => row.role === 'assistant');
  assert.deepEqual(assistant.content.find(part => part.type === 'toolCall').arguments, writeArgs, 'the recorded call is unchanged');
});

test('an interruption inside afterTool completes the call with the tool\'s own result, never uncertain', async t => {
  let entered;
  const waiting = new Promise(done => { entered = done; });
  const f = await fixture(t, { afterTool: async ({ signal }) => { entered(); await new Promise(done => signal.addEventListener('abort', done, { once: true })); return { content: [{ type: 'text', text: 'late' }] }; } });
  const running = f.session.prompt('Write it.').catch(error => error);
  await waiting; await f.session.abort(); await running;
  assert.deepEqual(f.executions.map(row => row.id), ['w1']);
  const recovery = f.session.snapshot().recovery;
  assert.equal(recovery.uncertainTools.length, 0); assert.equal(recovery.pendingTools, 0);
  assert.deepEqual(f.toolResults()[0].content.map(block => block.text), ['Saved a.md'], 'the write\'s own result, nothing from the interrupted check');
});

test('tool hooks must be functions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rna-tool-hooks-invalid-')); t.after(() => rm(directory, { recursive: true, force: true }));
  for (const hooks of [{ beforeTool: 'yes' }, { afterTool: {} }]) await assert.rejects(createSession({ cwd: directory, stateDir: join(directory, 'state'), model, provider: async function* () {}, ...hooks }), { code: 'invalid_options' });
});
