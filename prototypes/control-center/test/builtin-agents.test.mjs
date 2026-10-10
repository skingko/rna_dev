import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { BuiltinAgentService, builtinAgents, builtinPlugins, DELEGATION_LIMITS, scopePath, pathsOverlap, userWords, agentView, publicMerge, mergeLine } from '../builtin-agent-service.mjs';
import { applyProjectPermissions } from '../project-permissions.mjs';
import { runDelegatedAgent, CONVERSATION_LABEL } from '../../../packages/sdk/src/agent-delegation.mjs';
import { digest } from '../../../packages/sdk/src/journal.mjs';
import { RuntimeController } from '../runtime-controller.mjs';
import { createRnaRuntime } from '../rna-runtime.mjs';

async function until(check) { const deadline = Date.now() + 8000; while (!check()) { if (Date.now() > deadline) throw new Error('Fixture did not settle'); await delay(10); } }
function stream(res, { tool, name = 'project_write', args = { path: 'child.txt', content: 'verified child write', expectedHash: null }, text = 'Fixture response; no further artifact verification was performed.' } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = tool ? { tool_calls: [{ index: 0, id: 'child-write', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { content: text };
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
}
async function setup(t, respond = (_input, res) => stream(res)) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-child-')), calls = [];
  const server = http.createServer(async (req, res) => { let raw = ''; for await (const part of req) raw += part; const input = JSON.parse(raw); calls.push(input); await respond(input, res, calls.length); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const store = new Store(join(directory, 'private', 'state.json'));
  const provider = store.configurationService.provider(null, { name: 'Fixture', protocol: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'child-fixture-secret', models: [{ id: 'fixture-model', contextWindow: 64000, maxOutputTokens: 512, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { session, project } = store.createProject({ name: 'Child fixture', workspace: directory, initiative: { enabled: false } });
  store.mutate(state => applyProjectPermissions(state, project.id, { workspace: 'execute', background: 'read' }));
  store.message(session.id, { text: 'Parent task', requestId: 'parent-request' });
  const current = () => store.state.sessions.find(item => item.id === session.id), turnId = current().activeTurnId;
  const service = new BuiltinAgentService(store), tools = service.createTools({ sessionId: session.id, turnId });
  // Legacy joined execution (`wait: true`); background spawns pass `{}` or their own options.
  const run = (role, id = `call-${Date.now()}`, signal = new AbortController().signal, onUpdate, options = { wait: true }) => tools.find(tool => tool.name === (role === 'worker' ? 'agent_delegate' : 'agent_consult')).execute(id, role === 'worker' ? { task: 'Save the requested file.', ...options } : { role, task: 'Inspect the project evidence.', ...options }, signal, onUpdate);
  t.after(async () => { await service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, service, tools, calls, session, project, turnId, current, run };
}

test('builtin roles and packs describe real bounded Rna implementations and distinguish read consultation from worker', () => {
  assert.deepEqual(builtinAgents().map(role => [role.id, role.readOnly]), [['scout', true], ['planner', true], ['reviewer', true], ['worker', false]]);
  assert.ok(builtinPlugins().some(pack => pack.capabilities.includes('agent_delegate')));
  assert.ok(!builtinPlugins().some(pack => /codex|claude|ralph|llama/.test(pack.id)));
});

test('scout actually calls current provider, rejects attempted write, streams child progress and records real usage', async t => {
  const f = await setup(t, (_input, res, count) => stream(res, count === 1 ? { tool: true } : {})), updates = [];
  const result = await f.run('scout', 'scout', undefined, event => updates.push(event));
  assert.equal(JSON.parse(result.content[0].text).status, 'completed'); assert.equal(existsSync(join(f.directory, 'child.txt')), false);
  assert.ok(!f.calls[0].tools.some(tool => ['project_write', 'project_edit', 'project_exec', 'agent_delegate', 'agent_consult', 'capability_install', 'request_project_permission'].includes(tool.function.name)));
  assert.ok(!f.calls[0].tools.some(tool => tool.function.name === 'project_exec_output'), 'A fresh read-only scout has no command capture to inspect');
  assert.ok(updates.some(event => event.details.delegatedAgent.type === 'tool_execution_end'));
  assert.equal(f.store.state.realUsage.tokens, 40); assert.equal(f.current().usage.tokens, 40); assert.equal(f.current().turns[0].usage.totalTokens, 40);
  assert.equal(f.current().turns[0].delegations[0].status, 'completed');
});

test('worker really writes through granted tools, preserves child journal under parent, and duplicate completed call costs nothing', async t => {
  const f = await setup(t, (input, res, count) => {
    if (count === 3) { assert.match(JSON.stringify(input.messages.at(-1)), /host-delivery-observation/); return stream(res, { tool: true, name: 'project_read', args: { path: 'child.txt' } }); }
    if (count === 4) { assert.match(input.messages.at(-1).content, /verified child write/); return stream(res, { text: 'The file was written and read back. No visual or behavioral checks were performed.' }); }
    stream(res, count === 1 ? { tool: true } : { text: 'Draft file saved.' });
  });
  const first = await f.run('worker', 'worker-once'); assert.equal(readFileSync(join(f.directory, 'child.txt'), 'utf8'), 'verified child write');
  const id = JSON.parse(first.content[0].text).agentId, file = join(`${f.store.file}.rna`, f.session.id, 'agents', id, `${digest(id).slice(0, 24)}.rna.jsonl`);
  assert.ok(readFileSync(file, 'utf8').includes('verified child write')); assert.ok(!readFileSync(file, 'utf8').includes('child-fixture-secret'));
  const records = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.filter(row => row.type === 'finish_review' && row.data.status === 'continued').length, 1);
  assert.deepEqual(records.filter(row => row.type === 'tool_completed').map(row => row.data.message.toolName), ['project_write', 'project_read']);
  const second = await f.run('worker', 'worker-once'); assert.equal(JSON.parse(second.content[0].text).reused, true); assert.equal(f.calls.length, 4); assert.equal(f.store.state.realUsage.tokens, 80);
});

test('write-only project can delegate file implementation without gaining command execution', async t => {
  const f = await setup(t, (_input, res, count) => stream(res, count === 1 ? { tool: true } : {}));
  f.store.mutate(state => applyProjectPermissions(state, f.project.id, { workspace: 'write', background: 'read' }));
  assert.equal(f.tools.find(tool => tool.name === 'agent_delegate').permission, 'write');
  await f.run('worker', 'write-only'); assert.equal(readFileSync(join(f.directory, 'child.txt'), 'utf8'), 'verified child write');
  assert.ok(f.calls[0].tools.some(tool => tool.function.name === 'project_write')); assert.ok(!f.calls[0].tools.some(tool => tool.function.name === 'project_exec'));
});

test('worker permission revoked during model response prevents the already-requested write and stops further requests', async t => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const f = await setup(t, async (_input, res) => { await held; stream(res, { tool: true }); });
  const promise = f.run('worker', 'revoked'); await until(() => f.calls.length === 1);
  f.store.mutate(state => applyProjectPermissions(state, f.project.id, { workspace: 'read', background: 'read' })); release(); const result = await promise; assert.equal(result.isError, true); assert.equal(result.details.delegatedAgent.code, 'delegation_permission');
  assert.equal(existsSync(join(f.directory, 'child.txt')), false); assert.equal(f.calls.length, 1); assert.equal(f.store.state.realUsage.tokens, 20);
});

test('assignment revoked during model response is checked at actual tool execution without relying on next request refresh', async t => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const f = await setup(t, async (_input, res, count) => { if (count === 1) { await held; stream(res, { tool: true }); } else stream(res); });
  const promise = f.run('worker', 'assignment'); await until(() => f.calls.length === 1);
  f.store.mutate(state => { state.projects[0].assignments.toolIds = state.projects[0].assignments.toolIds.filter(id => id !== 'project_write'); }); release(); await promise;
  assert.equal(existsSync(join(f.directory, 'child.txt')), false); assert.ok(!f.calls[1].tools.some(tool => tool.function.name === 'project_write'));
});

test('plan parent cannot create a worker and global real budget rejects before child HTTP calls', async t => {
  const f = await setup(t); f.store.mutate(state => { state.sessions[0].turns[0].mode = 'plan'; });
  assert.equal((await f.run('worker', 'planned')).details.delegatedAgent.code, 'delegation_permission'); assert.equal(f.calls.length, 0);
  f.store.mutate(state => { state.settings.realTokenBudget = 1; });
  await assert.rejects(f.run('reviewer', 'budget'), { code: 'budget' }); assert.equal(f.calls.length, 0); assert.equal(f.store.state.realUsage.reservedTokens, 0);
});

test('cancel/drain settles children, conservatively accounts dispatched request and refuses automatic replay', async t => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const f = await setup(t, async (_input, res) => { await held; stream(res); });
  const pending = f.run('planner', 'cancelled'), rejected = assert.rejects(pending); await until(() => f.calls.length === 1);
  await f.service.drainSession(f.session.id); await rejected; release();
  assert.equal(f.service.running.size, 0); assert.equal(f.current().turns[0].delegations[0].status, 'cancelled'); assert.ok(f.store.state.realUsage.estimatedTokens > 0); assert.equal(f.store.state.realUsage.reservedTokens, 0);
  await assert.rejects(f.run('planner', 'cancelled'), { code: 'delegation_unresolved' }); assert.equal(f.calls.length, 1);
});

test('limits: steps by role, a runaway guard per turn, concurrency per conversation under a service ceiling', () => {
  assert.deepEqual(DELEGATION_LIMITS, { depth: 1, callsPerTurn: 12, concurrentPerSession: 4, concurrentTotal: 6, finalSummarySteps: 1 });
  assert.deepEqual(builtinAgents().map(role => [role.id, role.limits]), [
    ['scout', { depth: 1, callsPerTurn: 12, concurrent: 4, concurrentTotal: 6, steps: 24, finalSummarySteps: 1 }],
    ['planner', { depth: 1, callsPerTurn: 12, concurrent: 4, concurrentTotal: 6, steps: 24, finalSummarySteps: 1 }],
    ['reviewer', { depth: 1, callsPerTurn: 12, concurrent: 4, concurrentTotal: 6, steps: 24, finalSummarySteps: 1 }],
    ['worker', { depth: 1, callsPerTurn: 12, concurrent: 4, concurrentTotal: 6, steps: 32, finalSummarySteps: 1 }]]);
  assert.ok(builtinAgents().every(role => role.instruction === undefined && role.maxSteps === undefined), 'the model-facing instruction and raw step field stay internal');
});

test('the child runs with its role\'s steps: read-only roles 24, the worker 32', async t => {
  const f = await setup(t), seen = [];
  f.service.factory = options => { seen.push([options.readOnly, options.maxSteps, options.stepLimitBehavior]); return createRnaRuntime(options); };
  await f.run('reviewer', 'steps-reviewer'); await f.run('worker', 'steps-worker');
  assert.deepEqual(seen, [[true, 24, 'summarize'], [false, 32, 'summarize']]);
});

test('call bound is explicit and durable across host restart, while completed call remains reusable', async t => {
  const f = await setup(t); for (let i = 0; i < 12; i++) await f.run('reviewer', `limit-${i}`);
  assert.equal(f.calls.length, 12); // The guard keeps the work in this turn (the capability guidance: finish within the turn), never "continue next turn".
  await assert.rejects(f.run('reviewer', 'thirteenth'), { code: 'delegation_call_limit', message: /^This turn has started 12 subtasks[^]*do the rest yourself\.$/ });
  const second = new BuiltinAgentService(f.store); t.after(() => second.close());
  const tool = second.createTools({ sessionId: f.session.id, turnId: f.turnId })[0];
  await assert.rejects(tool.execute('thirteenth-after-restart', { role: 'reviewer', task: 'Inspect the project evidence.', wait: true }, new AbortController().signal), { code: 'delegation_call_limit' });
  const replay = await tool.execute('limit-0', { role: 'reviewer', task: 'Inspect the project evidence.', wait: true }, new AbortController().signal); assert.equal(JSON.parse(replay.content[0].text).reused, true); assert.equal(f.calls.length, 12);
});

test('concurrency counts per conversation: a fifth child in one is refused, another conversation still starts, the seventh overall is refused', async t => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const f = await setup(t, async (_input, res) => { await held; stream(res); });
  const other = f.store.createSession({ projectId: f.project.id }); f.store.message(other.id, { text: 'Second conversation', requestId: 'second-request' });
  const otherTurn = f.store.state.sessions.find(row => row.id === other.id).activeTurnId, otherTools = f.service.createTools({ sessionId: other.id, turnId: otherTurn });
  const spawn = (tools, id) => tools.find(tool => tool.name === 'agent_consult').execute(id, { role: 'scout', task: 'Inspect the project evidence.' }, new AbortController().signal);
  for (const id of ['a1', 'a2', 'a3', 'a4']) assert.equal(JSON.parse((await spawn(f.tools, id)).content[0].text).status, 'running');
  await assert.rejects(spawn(f.tools, 'a5'), { code: 'delegation_concurrency', message: /4 subtasks are already running in this conversation/ });
  for (const id of ['b1', 'b2']) assert.equal(JSON.parse((await spawn(otherTools, id)).content[0].text).status, 'running');
  await assert.rejects(spawn(otherTools, 'b3'), { code: 'delegation_concurrency', message: /6 subtasks are already running across all conversations/ });
  await until(() => f.calls.length === 6); assert.equal(f.service.running.size, 6);
  // A refused worker is a known, side-effect-free outcome for the parent.
  const refused = await f.tools.find(tool => tool.name === 'agent_delegate').execute('w-refused', { task: 'Save the requested file.' }, new AbortController().signal);
  assert.equal(refused.isError, true); assert.equal(refused.details.delegatedAgent.code, 'delegation_concurrency');
  await f.service.close(); release(); assert.equal(f.service.running.size, 0); assert.equal(f.calls.length, 6, 'refused spawns made no paid request');
});

test('worker files are normalized and compared by whole path segments', () => {
  const root = '/work/project';
  assert.equal(scopePath('./src//game/main.js', root), 'src/game/main.js'); assert.equal(scopePath('src\\ui\\', root), 'src/ui');
  assert.equal(scopePath('/work/project/docs/a.md', root), 'docs/a.md'); assert.equal(scopePath('/elsewhere/a.md', root), '/elsewhere/a.md');
  assert.equal(scopePath('.', root), ''); assert.equal(scopePath('  ', root), null); assert.equal(scopePath(7, root), null);
  assert.ok(pathsOverlap('src/game', 'src/game/main.js')); assert.ok(pathsOverlap('src/game/main.js', 'src/game'));
  assert.ok(pathsOverlap('SRC/Main.js', 'src/main.js'), 'one file under two spellings on a case-insensitive disk');
  assert.ok(!pathsOverlap('src/a.js', 'src/a.jsx')); assert.ok(!pathsOverlap('src/game', 'src/gameplay.js'));
  assert.ok(pathsOverlap('', 'anything/at/all'), 'the whole project overlaps every path');
});

test('a worker whose files overlap a running worker of the same conversation is started with a note, never refused', async t => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const f = await setup(t, async (_input, res) => { await held; stream(res); });
  const delegate = (id, files) => f.tools.find(tool => tool.name === 'agent_delegate').execute(id, { task: 'Change the game loop.', ...(files ? { files } : {}) }, new AbortController().signal).then(result => JSON.parse(result.content[0].text));
  const first = await delegate('w1', ['src/game']);
  assert.equal(first.filesOverlap, undefined);
  const second = await delegate('w2', ['./src/game/main.js', 'docs/notes.md']);
  assert.equal(second.status, 'running', 'an overlap is a note, not a lock');
  assert.deepEqual(second.filesOverlap, [{ agentId: first.agentId, paths: ['src/game/main.js'] }]);
  assert.match(second.filesNote, /overlap the files a worker still running/); assert.match(second.next, /Running in the background/);
  const third = await delegate('w3', ['src/gameplay.js']), fourth = await delegate('w4');
  assert.equal(third.filesOverlap, undefined); assert.equal(fourth.filesOverlap, undefined, 'without files there is nothing to compare');
  assert.deepEqual(f.current().turns[0].delegations.find(row => row.id === second.agentId).files, ['src/game/main.js', 'docs/notes.md']);
  await f.service.close(); release();
});

test('the worker result lists writes outside its declared files; inside them there is nothing to report', async t => {
  // Each worker writes the file its task names, reads it back when the host asks for a delivery check, then answers.
  const f = await setup(t, (input, res) => {
    const all = JSON.stringify(input.messages), path = /FILE-ONE/.test(all) ? 'first.txt' : /FILE-TWO/.test(all) ? 'second.txt' : 'third.txt', results = input.messages.filter(message => message.role === 'tool').length;
    if (!results) return stream(res, { tool: true, args: { path, content: 'verified child write', expectedHash: null } });
    if (/host-delivery-observation/.test(JSON.stringify(input.messages.at(-1)))) return stream(res, { tool: true, name: 'project_read', args: { path } });
    stream(res, { text: results === 1 ? 'Draft file saved.' : `Saved ${path} and read it back.` });
  });
  const delegate = async (id, args) => JSON.parse((await f.tools.find(tool => tool.name === 'agent_delegate').execute(id, { wait: true, ...args }, new AbortController().signal)).content[0].text);
  const outside = await delegate('outside', { task: 'Save FILE-ONE.', files: ['notes/'] });
  assert.equal(readFileSync(join(f.directory, 'first.txt'), 'utf8'), 'verified child write');
  assert.deepEqual(outside.outsideFiles, ['first.txt']);
  assert.deepEqual(f.current().turns[0].delegations.find(row => row.id === outside.agentId).outsideFiles, ['first.txt']);
  const inside = await delegate('inside', { task: 'Save FILE-TWO.', files: ['./second.txt'] });
  assert.equal(readFileSync(join(f.directory, 'second.txt'), 'utf8'), 'verified child write'); assert.equal(inside.outsideFiles, undefined);
  const undeclared = await delegate('undeclared', { task: 'Save FILE-THREE.' });
  assert.equal(readFileSync(join(f.directory, 'third.txt'), 'utf8'), 'verified child write'); assert.equal(undeclared.outsideFiles, undefined, 'no files, no scope to compare with');
});

test('includeConversation attaches only the user\'s own recent words, labelled as their requirements and cut to the budget, newest last', async t => {
  const f = await setup(t), at = new Date().toISOString();
  f.store.mutate(state => {
    const session = state.sessions.find(row => row.id === f.session.id);
    session.items.push(
      { id: 'u-tone', kind: 'user', text: 'Use the ink-wash tone.', createdAt: at, simulated: false },
      { id: 'u-agent', kind: 'user', source: 'subagent', text: '[宿主通知 · 子代理完成] host words', createdAt: at, simulated: false },
      { id: 'u-card', kind: 'user', source: 'interaction-answer', text: 'card answer words', createdAt: at, simulated: false },
      { id: 'u-gone', kind: 'user', text: 'deleted words', sourceDeleted: true, createdAt: at, simulated: false },
      { id: 'u-long', kind: 'user', text: 'y'.repeat(3990), createdAt: at, simulated: false });
  });
  assert.deepEqual(userWords(f.current()).map(text => text.slice(0, 12)), ['Parent task', 'Use the ink-', 'yyyyyyyyyyyy']);
  const consult = (id, args) => f.tools.find(tool => tool.name === 'agent_consult').execute(id, { role: 'scout', task: 'Find the style guide.', wait: true, ...args }, new AbortController().signal);
  await consult('with-words', { includeConversation: true });
  const sent = JSON.stringify(f.calls[0].messages), parts = f.calls[0].messages.filter(message => message.role === 'user').flatMap(message => typeof message.content === 'string' ? [message.content] : message.content.map(part => part.text ?? ''));
  const block = parts.find(part => part.includes('"parent-conversation"')), task = parts.findIndex(part => part.includes('Find the style guide.'));
  assert.ok(block && task >= 0, 'the task and the attached words reach the child');
  assert.match(block, /^Find the style guide\.\n\[The user's own words from the parent conversation, attached by the parent agent\./, 'the user\'s requirements next to the task, not untrusted reference data');
  const attached = JSON.parse(block.slice(block.indexOf('\n[{"source"') + 1)).find(row => row.source === 'parent-conversation').text;
  assert.equal(attached, `${CONVERSATION_LABEL}\n\n[User message 1 of 2]\nUse the i…\n\n[User message 2 of 2, latest]\n${'y'.repeat(3990)}`, 'the newest gets the room; the next is cut with an ellipsis; older ones are left out');
  assert.match(CONVERSATION_LABEL, /The user's own words from the parent conversation, newest last: their requirements for this work; the task decides the scope\./);
  assert.doesNotMatch(sent, /host words|card answer words|deleted words|Parent task/);
  assert.equal(f.current().turns[0].delegations[0].includeConversation, true);
  await consult('without-words', {});
  assert.doesNotMatch(JSON.stringify(f.calls[1].messages), /parent conversation/);
});

test('a child that ran out of steps is recorded, told to the parent and named in the notice', async t => {
  const f = await setup(t, (input, res) => stream(res, input.tools?.length ? { tool: true, name: 'project_list', args: { path: '.' } } : { text: 'Looked at the top level only; the rest is unchecked.' }));
  f.service.factory = options => createRnaRuntime({ ...options, maxSteps: 1 });
  const result = JSON.parse((await f.run('scout', 'cap')).content[0].text);
  assert.equal(result.status, 'completed'); assert.equal(result.stepLimitReached, true);
  const record = f.current().turns[0].delegations[0];
  assert.equal(record.stepLimit, true); assert.equal(record.output, 'Looked at the top level only; the rest is unchecked.');
  const status = JSON.parse((await f.tools.find(tool => tool.name === 'agent_status').execute('status', { agentId: record.id }, new AbortController().signal)).content[0].text);
  assert.equal(status.stepLimitReached, true);
});

test('SDK runner enforces no recursive delegation before prompting even with an incorrect host factory', async () => {
  let prompted = false, disposed = false;
  await assert.rejects(runDelegatedAgent({ role: 'scout', task: 'inspect', sessionId: 'child', signal: new AbortController().signal, createChild: async () => ({ snapshot: () => ({ tools: ['agent_delegate'], recovery: { uncertainTools: [] } }), prompt: async () => { prompted = true; }, dispose: async () => { disposed = true; } }) }), { code: 'delegation_depth' });
  assert.equal(prompted, false); assert.equal(disposed, true);
});

test('actual parent SDK tool delegation joins the child and meters both model loops once', async t => {
  const f = await setup(t, (input, res, count) => {
    if (count === 4) { assert.match(JSON.stringify(input.messages.at(-1)), /host-delivery-observation/); return stream(res, { tool: true, name: 'project_read', args: { path: 'child.txt' } }); }
    if (count === 5) { assert.match(input.messages.at(-1).content, /verified child write/); return stream(res, { text: 'File content was read back; no additional behavior was tested.' }); }
    stream(res, count === 1 ? { tool: true, name: 'agent_delegate', args: { task: 'Save the requested file.', wait: true } } : count === 2 ? { tool: true } : { text: count === 3 ? 'Draft file saved.' : 'The child saved and read back the file; other properties remain unverified.' });
  });
  const executor = new RuntimeController(f.store, { builtinAgentService: f.service }); t.after(() => executor.close());
  await until(() => ['completed', 'failed'].includes(f.current().turns[0]?.status));
  assert.equal(f.current().turns[0].status, 'completed'); assert.equal(f.calls.length, 6); assert.equal(readFileSync(join(f.directory, 'child.txt'), 'utf8'), 'verified child write');
  assert.equal(f.store.state.realUsage.tokens, 120); assert.equal(f.current().turns[0].usage.totalTokens, 120); assert.equal(f.current().usage.tokens, 120);
  assert.deepEqual(f.current().items.filter(item => item.tool).map(item => item.tool.name), ['agent_delegate']);
  assert.equal(f.current().turns[0].delegations[0].usage.totalTokens, 80);
});

test('known child model failure returns a failed tool result without falsely leaving a parent mutation unresolved', async t => {
  const f = await setup(t, (_input, res, count) => {
    if (count === 2) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"fixture failure"}}'); }
    else stream(res, count === 1 ? { tool: true, name: 'agent_delegate', args: { task: 'Save the requested file.', wait: true } } : { text: 'Child failed; no implementation was completed.' });
  });
  const executor = new RuntimeController(f.store, { builtinAgentService: f.service }); t.after(() => executor.close());
  await until(() => ['completed', 'failed'].includes(f.current().turns[0]?.status));
  assert.equal(f.current().turns[0].status, 'completed'); assert.equal(f.current().items.find(item => item.tool).tool.status, 'failed'); assert.equal(f.calls.length, 3);
  assert.equal(existsSync(join(f.directory, 'child.txt')), false); assert.equal(f.current().turns[0].delegations[0].status, 'failed');
});

test('uncertain child operation propagates through the parent tool boundary and never auto-replays the child', async t => {
  const f = await setup(t, (_input, res, count) => stream(res, count === 1 ? { tool: true, name: 'agent_delegate', args: { task: 'Save the requested file.', wait: true } } : { tool: true, name: 'uncertain_operation', args: {} }));
  let operations = 0;
  f.service.factory = options => createRnaRuntime({ ...options, managementTools: [{ name: 'uncertain_operation', permission: 'write', effect: 'write', parameters: { type: 'object', properties: {} }, execute: async () => { operations++; throw new Error('fixture result unknown'); } }] });
  const executor = new RuntimeController(f.store, { builtinAgentService: f.service }); t.after(() => executor.close());
  await until(() => ['completed', 'failed', 'paused'].includes(f.current().turns[0]?.status));
  assert.equal(f.current().turns[0].status, 'paused'); assert.equal(f.current().pauseReason, 'recovery'); assert.equal(f.current().runtime.recovery.uncertainTools.length, 1); assert.equal(f.current().items.find(item => item.tool).tool.status, 'uncertain'); assert.equal(operations, 1); assert.equal(f.calls.length, 2);
  assert.equal(f.current().turns[0].delegations[0].status, 'failed');
});

test('a joined worker without isolation reports shared_root in its result; the card shows it and agent_merge has nothing to merge', async t => {
  const f = await setup(t, (input, res) => {
    const results = input.messages.filter(message => message.role === 'tool').length;
    if (!results) return stream(res, { tool: true });
    if (/host-delivery-observation/.test(JSON.stringify(input.messages.at(-1)))) return stream(res, { tool: true, name: 'project_read', args: { path: 'child.txt' } });
    stream(res, { text: 'Saved child.txt and read it back.' });
  });
  const result = JSON.parse((await f.run('worker', 'joined-worker')).content[0].text);
  assert.equal(result.status, 'completed'); assert.equal(readFileSync(join(f.directory, 'child.txt'), 'utf8'), 'verified child write');
  assert.deepEqual(result.merge, { status: 'shared_root', reason: 'not_ready' });
  assert.equal(result.mergeNote, 'It worked directly in your files (no isolated copy: not_ready).');
  assert.deepEqual(f.current().items.find(row => row.kind === 'subagent').subagent.merge, { status: 'shared_root', applyIds: [], reason: 'not_ready' });
  const merge = f.tools.find(tool => tool.name === 'agent_merge');
  assert.equal((await merge.execute('m', { agentId: result.agentId }, new AbortController().signal)).details.code, 'merge_shared_root');
  assert.equal((await merge.execute('m', { agentId: result.agentId, changeId: 'x' }, new AbortController().signal)).details.code, 'merge_unknown', 'the host refuses both ids as well');
  const scout = JSON.parse((await f.run('scout', 'joined-scout')).content[0].text);
  assert.equal(scout.merge, undefined, 'read-only roles have no merge at all');
});

test('pendingMerges lists this conversation\'s ended workers whose changes are not in its files yet, oldest first, and never throws', async t => {
  const f = await setup(t);
  const at = minutes => new Date(Date.UTC(2026, 9, 4, 10, minutes)).toISOString();
  f.store.mutate(state => {
    const turn = state.sessions.find(row => row.id === f.session.id).turns[0];
    turn.delegations = [
      { id: 'agent-late', role: 'worker', task: 'Second', status: 'failed', endedAt: at(30), merge: { status: 'conflict', applyIds: ['a1'], conflicts: [{ path: 'x.js', kind: 'content' }], files: 2 } },
      { id: 'agent-early', role: 'worker', task: 'First', status: 'cancelled', endedAt: at(10), merge: { status: 'pending', applyIds: [], reason: 'cancelled' } },
      { id: 'agent-failed-merge', role: 'worker', task: 'Third', status: 'completed', endedAt: at(40), merge: { status: 'pending', applyIds: [], reason: 'snapshot_unreadable' } },
      { id: 'agent-running', role: 'worker', task: 'Running', status: 'running', merge: { status: 'pending', applyIds: [] } },
      { id: 'agent-merged', role: 'worker', status: 'completed', endedAt: at(5), merge: { status: 'merged', applyIds: ['a0'], files: 1 } },
      { id: 'agent-shared', role: 'worker', status: 'completed', endedAt: at(6), merge: { status: 'shared_root', applyIds: [], reason: 'no_repository' } },
      { id: 'agent-scout', role: 'scout', status: 'completed', endedAt: at(7) },
      { id: 'agent-many', role: 'worker', status: 'completed', endedAt: at(8), merge: { status: 'merged', applyIds: ['a2'], files: 45 }, mergeWork: { applied: ['a.js', 'b.js', 'c.js'] } }
    ];
  });
  assert.deepEqual(f.service.pendingMerges(f.session.id), [
    { agentId: 'agent-early', role: 'worker', task: 'First', turnId: f.turnId, status: 'pending', reason: 'cancelled', conflicts: [] },
    { agentId: 'agent-late', role: 'worker', task: 'Second', turnId: f.turnId, status: 'conflict', conflicts: [{ path: 'x.js', kind: 'content' }] },
    { agentId: 'agent-failed-merge', role: 'worker', task: 'Third', turnId: f.turnId, status: 'pending', conflicts: [] }
  ]);
  assert.deepEqual(f.service.pendingMerges('no-such-session'), []);
  // What the card and the parent model read: the protocol's delegation.merge, and one English line.
  const late = f.service.record(f.session.id, 'agent-late');
  assert.deepEqual(agentView(late).merge, { status: 'conflict', applyIds: ['a1'], conflicts: [{ path: 'x.js', kind: 'content' }], files: 2 });
  assert.equal(publicMerge(null), null);
  assert.match(mergeLine(f.service.record(f.session.id, 'agent-failed-merge')), /^The host has not merged its changes \(snapshot_unreadable\)\. agent_merge\(\{"agentId":"agent-failed-merge"\}\) merges them; action drop discards them\.$/);
  assert.equal(mergeLine(f.service.record(f.session.id, 'agent-running')), '', 'nothing is said about a running worker');
  assert.equal(mergeLine(f.service.record(f.session.id, 'agent-scout')), '');
  // The record keeps the first paths only; the line still counts them all.
  assert.match(mergeLine(f.service.record(f.session.id, 'agent-many')), /merged into your files: a\.js, b\.js, c\.js, \+42 more\./);
  assert.match(mergeLine(late), /^Merged 2 file\(s\) into your files; 1 file\(s\) conflict/);
  for (const line of [late, f.service.record(f.session.id, 'agent-early')].map(mergeLine)) assert.match(line, /^[\x20-\x7e]+$/, 'model-facing lines are English');
});

test('a subagent card drops a worktree id once the worktree is gone', async t => {
  const f = await setup(t);
  f.store.mutate(state => {
    const session = state.sessions.find(row => row.id === f.session.id);
    session.turns[0].delegations = [{ id: 'agent-w', role: 'worker', task: 'T', status: 'completed', worktree: { id: 'wt-1' }, merge: { status: 'conflict', applyIds: [], conflicts: [{ path: 'a', kind: 'binary' }] } }];
    session.items.push({ id: 'item-w', turnId: f.turnId, kind: 'subagent', text: 'T', createdAt: new Date().toISOString(), subagent: { agentId: 'agent-w', worktreeId: 'wt-1', merge: { status: 'conflict' } } });
  });
  assert.equal(agentView(f.service.record(f.session.id, 'agent-w')).worktreeId, 'wt-1');
  f.service.patch({ sessionId: f.session.id, turnId: f.turnId, id: 'agent-w' }, { worktree: { id: 'wt-1', removed: true }, merge: { status: 'merged', applyIds: ['a'], files: 1 } });
  const card = f.current().items.find(row => row.id === 'item-w').subagent;
  assert.equal(card.worktreeId, undefined); assert.deepEqual(card.merge, { status: 'merged', applyIds: ['a'], files: 1 });
});
