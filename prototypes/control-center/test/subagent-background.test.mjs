import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { BuiltinAgentService, mergeLine } from '../builtin-agent-service.mjs';
import { createAgentRoutes } from '../agent-routes.mjs';
import { applyProjectPermissions } from '../project-permissions.mjs';
import { RuntimeController } from '../runtime-controller.mjs';
import { UsageLedger } from '../usage-cache-service.mjs';
import { DELEGATION_TOOL_NAMES } from '../../../packages/sdk/src/agent-delegation.mjs';

async function until(check, ms = 20000) { const deadline = Date.now() + ms; while (!check()) { if (Date.now() > deadline) throw new Error('Fixture did not settle'); await delay(10); } }
function stream(res, { tool, name = 'project_write', id = `call-${name}`, args = { path: 'child.txt', content: 'verified child write', expectedHash: null }, text = 'Fixture response; nothing else was verified.' } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = tool ? { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { content: text };
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
}
const isParent = input => input.tools?.some(tool => tool.function.name === 'agent_consult');
const said = (input, pattern) => pattern.test(JSON.stringify(input.messages));
// respond(input, res, { parent, child, count }) — separate counters for parent and child requests.
async function setup(t, respond, { start = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-bg-')), calls = [], counts = { parent: 0, child: 0 };
  const server = http.createServer(async (req, res) => { let raw = ''; for await (const part of req) raw += part; const input = JSON.parse(raw); calls.push(input); const parent = isParent(input); counts[parent ? 'parent' : 'child']++; await respond(input, res, { parent, count: counts[parent ? 'parent' : 'child'] }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const store = new Store(join(directory, 'private', 'state.json')); store.usageLedger = new UsageLedger();
  const provider = store.configurationService.provider(null, { name: 'Fixture', protocol: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'bg-fixture-secret', models: [{ id: 'fixture-model', contextWindow: 64000, maxOutputTokens: 512, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { session, project } = store.createProject({ name: 'Background fixture', workspace: directory, initiative: { enabled: false } });
  store.mutate(state => applyProjectPermissions(state, project.id, { workspace: 'execute', background: 'read' }));
  store.message(session.id, { text: 'Parent task', requestId: 'parent-request' });
  const current = () => store.state.sessions.find(item => item.id === session.id), turnId = current().activeTurnId;
  const service = new BuiltinAgentService(store), tools = service.createTools({ sessionId: session.id, turnId });
  const tool = name => tools.find(row => row.name === name);
  const call = (name, args, id = `${name}-${Math.random()}`, signal = new AbortController().signal) => tool(name).execute(id, args, signal);
  const body = result => JSON.parse(result.content[0].text);
  let executor = null;
  if (start) executor = new RuntimeController(store, { builtinAgentService: service });
  t.after(async () => { await executor?.close(); await service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, service, tools, call, body, calls, counts, session, project, turnId, current, record: id => service.record(session.id, id), item: id => current().items.find(row => row.kind === 'subagent' && row.subagent.agentId === id) };
}
const gate = () => { let release; const held = new Promise(resolve => { release = resolve; }); return { held, release }; };

test('SDK declares async spawn options and the four control tools; child tools never include any of them', async t => {
  const f = await setup(t, (_input, res) => stream(res), { start: false });
  assert.deepEqual(f.tools.map(row => row.name), DELEGATION_TOOL_NAMES);
  assert.ok(f.tools[0].parameters.properties.wait && f.tools[0].parameters.properties.continueAfter);
  const handle = f.body(await f.call('agent_consult', { role: 'scout', task: 'Inspect the project evidence.' }));
  await until(() => f.record(handle.agentId)?.status === 'completed');
  assert.ok(!f.calls[0].tools.some(row => DELEGATION_TOOL_NAMES.includes(row.function.name)), 'depth 1: no delegation or control tools in the child');
  assert.deepEqual(f.store.usageLedger.rows.map(row => row.purpose), ['subagent'], 'child requests are metered with the subagent purpose');
});

test('parent continues its turn while the background child is still running; idle parent then gets one visible notice and no new turn', async t => {
  const child = gate();
  const f = await setup(t, async (input, res, { parent, count }) => {
    if (!parent) { await child.held; return stream(res, { text: 'Scout found the entry point in src/index.js.' }); }
    if (count === 1) return stream(res, { tool: true, name: 'agent_consult', args: { role: 'scout', task: 'Find the entry point.' } });
    stream(res, { text: 'I started a scout and will report when it returns.' });
  });
  await until(() => f.current().turns[0].status === 'completed');
  const [record] = f.current().turns[0].delegations;
  assert.equal(record.status, 'running', 'the parent finished its reply while the child was still running');
  assert.equal(f.counts.parent, 2); await until(() => f.counts.child === 1);
  assert.equal(f.item(record.id).subagent.status, 'running'); assert.equal(f.item(record.id).subagent.task, 'Find the entry point.');
  child.release(); await until(() => f.record(record.id).delivery?.status === 'noticed');
  const notices = f.current().items.filter(row => row.kind === 'notice' && row.source === 'subagent');
  assert.equal(notices.length, 1); assert.match(notices[0].text, /^子代理完成：项目侦察/);
  assert.equal(f.current().turns.length, 1, 'no unrequested paid turn'); assert.equal(f.counts.parent, 2);
  const view = f.item(record.id).subagent;
  assert.equal(view.status, 'completed'); assert.match(view.summary, /entry point/); assert.equal(view.usage.totalTokens, 20); assert.ok(view.startedAt && view.endedAt);
  f.service.deliver(f.session.id, record.id); f.service.recover();
  assert.equal(f.current().items.filter(row => row.kind === 'notice' && row.source === 'subagent').length, 1, 'delivered once');
});

test('two agent_consult calls issued back to back both start in the background; the parent keeps working and each result arrives once', async t => {
  const child = gate(); let handed = null;
  const f = await setup(t, async (input, res, { parent, count }) => {
    if (!parent) { await child.held; return stream(res, { text: said(input, /chapter one/) ? 'Chapter one reads in an ink-wash tone.' : 'Chapter two drags in the middle.' }); }
    if (count === 1) return stream(res, { tool: true, name: 'agent_consult', id: 'consult-one', args: { role: 'scout', task: 'Read chapter one and report its tone.' } });
    if (count === 2) { handed = input.messages.at(-1); return stream(res, { tool: true, name: 'agent_consult', id: 'consult-two', args: { role: 'reviewer', task: 'Review the pacing of chapter two.', includeConversation: true } }); }
    stream(res, { text: 'Two subagents are reading the chapters; I drafted the outline meanwhile.' });
  });
  await until(() => f.current().turns[0].status === 'completed');
  const ids = f.current().turns[0].delegations.map(row => row.id);
  assert.equal(ids.length, 2); assert.notEqual(ids[0], ids[1]);
  assert.deepEqual(ids.map(id => f.record(id).status), ['running', 'running'], 'the parent finished its reply while both children ran');
  assert.equal(f.counts.parent, 3, 'the second spawn followed the first without waiting for it');
  assert.match(JSON.stringify(handed), /"status\\?":\\?"running/, 'the first spawn returned a running handle at once');
  await until(() => f.counts.child === 2); assert.equal(f.service.running.size, 2, 'both children run at the same time');
  assert.equal(f.record(ids[1]).includeConversation, true);
  child.release();
  await until(() => ids.every(id => f.record(id).delivery?.status === 'noticed'));
  const notices = f.current().items.filter(row => row.kind === 'notice' && row.source === 'subagent').map(row => row.text);
  assert.equal(notices.length, 2);
  assert.ok(notices.some(text => /^子代理完成：项目侦察 · Chapter one/.test(text)) && notices.some(text => /^子代理完成：交付审阅 · Chapter two/.test(text)), notices.join('\n'));
  assert.equal(f.current().turns.length, 1, 'no unrequested paid turn'); assert.equal(f.counts.parent, 3);
});

test('completion is delivered exactly once to a running parent at its next safe boundary', async t => {
  let notified = 0;
  const f = await setup(t, async (input, res, { parent, count }) => {
    if (!parent) return stream(res, { text: 'Review: the change is consistent with the tests.' });
    if (count === 1) return stream(res, { tool: true, name: 'agent_consult', args: { role: 'reviewer', task: 'Review the change.' } });
    if (count === 2) { await until(() => f.current().inbox.some(row => row.source === 'subagent') && f.current().inbox.every(row => row.deliveryStatus === 'accepted')); return stream(res, { text: 'Meanwhile I checked the docs.' }); }
    if (said(input, /Host notice · subagent finished/)) notified++;
    stream(res, { text: 'The reviewer agrees; done.' });
  });
  await until(() => f.current().turns[0].status === 'completed');
  assert.equal(f.counts.parent, 3); assert.equal(notified, 1);
  const [record] = f.current().turns[0].delegations;
  assert.equal(record.delivery.status, 'steered'); assert.equal(f.current().turns.length, 1);
  const steered = f.current().items.filter(row => row.kind === 'user' && row.source === 'subagent');
  assert.equal(steered.length, 1); assert.equal(steered[0].agentId, record.id); assert.equal(f.current().inbox.length, 0);
  assert.ok(!f.current().items.some(row => row.kind === 'notice' && row.source === 'subagent'));
  assert.equal(f.item(record.id).subagent.delivery, 'steered');
});

test('continueAfter wakes an idle parent with one follow-up turn carrying the result', async t => {
  const child = gate();
  const f = await setup(t, async (input, res, { parent, count }) => {
    if (!parent) { await child.held; return stream(res, { text: 'Plan: three steps.' }); }
    if (count === 1) return stream(res, { tool: true, name: 'agent_consult', args: { role: 'planner', task: 'Plan it.', continueAfter: true } });
    if (count === 2) return stream(res, { text: 'Planner started; I will continue when it returns.' });
    assert.match(JSON.stringify(input.messages), /Plan: three steps/); stream(res, { text: 'Applying the plan summary.' });
  });
  await until(() => f.current().turns[0].status === 'completed'); child.release();
  await until(() => f.current().turns[1]?.status === 'completed');
  assert.equal(f.current().turns.length, 2); assert.equal(f.counts.parent, 3);
  assert.equal(f.current().items.find(row => row.id === f.current().turns[1].userItemId).source, 'subagent');
  assert.equal(f.current().turns[0].delegations[0].delivery.status, 'woke');
});

test('agent_wait joins a background child without a second notification; timeout leaves it running', async t => {
  const child = gate();
  const f = await setup(t, async (_input, res) => { await child.held; stream(res, { text: 'Evidence: README mentions the API.' }); }, { start: false });
  const handle = f.body(await f.call('agent_consult', { role: 'scout', task: 'Inspect.' }));
  assert.equal(handle.status, 'running'); assert.equal(handle.background, true);
  const timed = f.body(await f.call('agent_wait', { agentIds: [handle.agentId], timeoutSeconds: 1 }));
  assert.equal(timed.timedOut, true); assert.equal(timed.agents[0].status, 'running');
  const waiting = f.call('agent_wait', { timeoutSeconds: 30 }); child.release();
  const joined = f.body(await waiting);
  assert.equal(joined.timedOut, false); assert.equal(joined.agents[0].status, 'completed'); assert.match(joined.agents[0].output, /README/);
  assert.equal(f.record(handle.agentId).delivery.status, 'joined');
  assert.ok(!f.current().inbox.length && !f.current().items.some(row => row.kind === 'notice' && row.source === 'subagent'));
  const listed = f.body(await f.call('agent_status', {})); assert.equal(listed.agents.length, 1); assert.equal(listed.agents[0].output, undefined);
  assert.match(f.body(await f.call('agent_status', { agentId: handle.agentId })).output, /README/);
});

test('agent_message steers a running child at its next boundary and is refused after it ends', async t => {
  const child = gate(); let steeredRequest = null;
  const f = await setup(t, async (input, res, { count }) => {
    if (count === 1) { await child.held; return stream(res, { text: 'First look: nothing yet.' }); }
    steeredRequest = input; stream(res, { text: 'Checked the config directory as asked: it holds app.json.' });
  }, { start: false });
  const handle = f.body(await f.call('agent_consult', { role: 'scout', task: 'Inspect.' }));
  await until(() => f.calls.length === 1);
  const sent = f.body(await f.call('agent_message', { agentId: handle.agentId, message: 'Also check the config directory.' }));
  assert.equal(sent.delivered, true); child.release();
  await until(() => ['completed', 'failed'].includes(f.record(handle.agentId).status));
  assert.equal(f.record(handle.agentId).status, 'completed'); assert.match(JSON.stringify(steeredRequest.messages), /Guidance from the parent agent.*config directory/);
  assert.match(f.record(handle.agentId).output, /app\.json/); assert.equal(f.item(handle.agentId).subagent.messages, 1);
  const late = await f.call('agent_message', { agentId: handle.agentId, message: 'One more thing.' });
  assert.equal(late.isError, true); assert.equal(f.body(late).delivered, false); assert.equal(f.calls.length, 2);
});

test('cancel: parent cancel is reported by its tool result; user cancel via HTTP route notifies the parent', async t => {
  const f = await setup(t, async (_input, _res) => {}, { start: false });
  const first = f.body(await f.call('agent_consult', { role: 'scout', task: 'Inspect A.' }));
  const second = f.body(await f.call('agent_consult', { role: 'planner', task: 'Plan B.' }));
  await until(() => f.calls.length === 2);
  const cancelled = f.body(await f.call('agent_cancel', { agentId: first.agentId }));
  assert.equal(cancelled.status, 'cancelled'); assert.equal(f.record(first.agentId).delivery.status, 'reported');
  const sent = []; const routes = createAgentRoutes({ store: f.store, agents: f.service, body: async () => ({}) });
  const send = (status, value) => sent.push([status, value]);
  assert.equal(await routes({ method: 'GET' }, { pathname: `/api/v2/sessions/${f.session.id}/agents`, send }), true);
  assert.deepEqual(sent[0][1].agents.map(row => [row.agentId, row.status]), [[first.agentId, 'cancelled'], [second.agentId, 'running']]);
  assert.equal(await routes({ method: 'POST' }, { pathname: `/api/v2/sessions/${f.session.id}/agents/${second.agentId}/cancel`, send }), true);
  assert.equal(sent[1][0], 200); assert.equal(sent[1][1].status, 'cancelled');
  assert.equal(f.record(second.agentId).delivery.status, 'steered', 'parent turn is still active, so the notice is queued as steering');
  assert.match(f.current().inbox.find(row => row.agentId === second.agentId).text, /^\[Host notice · subagent cancelled\]/);
  await assert.rejects(routes({ method: 'POST' }, { pathname: `/api/v2/sessions/${f.session.id}/agents/agent-missing/cancel`, send }), { status: 404 });
  assert.equal(f.service.running.size, 0); assert.equal(f.store.state.realUsage.reservedTokens, 0);
  // A stopped parent turn with a queued subagent notice keeps it as a notice, not an editable user message.
  const stopped = f.store.controlSession(f.session.id, 'stop');
  assert.equal(stopped.recovered.length, 0); assert.ok(f.current().items.some(row => row.kind === 'notice' && row.source === 'subagent' && /子代理已取消/.test(row.text)));
  // The model never read it: the record says so, and the next request carries it (cc/subagent-results.mjs).
  assert.equal(f.record(second.agentId).delivery.status, 'noticed'); assert.equal(f.item(second.agentId).subagent.delivery, 'noticed');
});

test('explicit stop of the spawning turn cancels its background children; plain turn completion does not', async t => {
  const f = await setup(t, async () => {}, { start: false });
  const handle = f.body(await f.call('agent_consult', { role: 'scout', task: 'Inspect.' }));
  await until(() => f.calls.length === 1);
  f.store.finishRuntimeTurn(f.session.id, f.turnId); await delay(30);
  assert.equal(f.record(handle.agentId).status, 'running', 'completion of the parent turn does not stop the child');
  f.store.mutate(state => { const turn = state.sessions.find(row => row.id === f.session.id).turns[0]; turn.status = 'stopped'; });
  await until(() => f.record(handle.agentId).status !== 'running');
  assert.equal(f.record(handle.agentId).status, 'cancelled'); assert.equal(f.record(handle.agentId).delivery.status, 'noticed');
});

test('background worker obeys live permission revocation and plan mode; no write happens after revocation', async t => {
  const child = gate();
  const f = await setup(t, async (_input, res) => { await child.held; stream(res, { tool: true }); }, { start: false });
  const handle = f.body(await f.call('agent_delegate', { task: 'Save the requested file.' }));
  await until(() => f.calls.length === 1);
  f.store.mutate(state => applyProjectPermissions(state, f.project.id, { workspace: 'read', background: 'read' })); child.release();
  await until(() => f.record(handle.agentId).status !== 'running');
  assert.equal(f.record(handle.agentId).status, 'failed'); assert.equal(f.record(handle.agentId).code, 'delegation_permission');
  assert.equal(existsSync(join(f.directory, 'child.txt')), false); assert.equal(f.calls.length, 1);
  assert.match(f.current().inbox.find(row => row.agentId === handle.agentId).text, /delegation_permission/);
  f.store.mutate(state => { applyProjectPermissions(state, f.project.id, { workspace: 'execute', background: 'read' }); state.sessions.find(row => row.id === f.session.id).turns[0].mode = 'plan'; });
  const refused = await f.call('agent_delegate', { task: 'Save it again.' });
  assert.equal(refused.isError, true); assert.equal(refused.details.delegatedAgent.code, 'delegation_permission'); assert.equal(f.calls.length, 1);
});

test('replayed spawn call never starts a second child or repeats its side effect', async t => {
  const child = gate();
  const f = await setup(t, async (_input, res, { count }) => { if (count === 1) { await child.held; return stream(res, { tool: true }); } stream(res, { text: 'Saved child.txt; not otherwise verified.' }); }, { start: false });
  const args = { task: 'Save the requested file.' };
  const first = f.body(await f.call('agent_delegate', args, 'same-call'));
  const replay = f.body(await f.call('agent_delegate', args, 'same-call'));
  assert.equal(replay.agentId, first.agentId); assert.equal(replay.status, 'running'); assert.equal(f.service.running.size, 1);
  await assert.rejects(f.call('agent_delegate', { task: 'Different task.' }, 'same-call'), { code: 'delegation_identity' });
  child.release(); await until(() => f.record(first.agentId).status === 'completed');
  const after = f.body(await f.call('agent_delegate', args, 'same-call'));
  assert.equal(after.status, 'completed'); assert.equal(f.calls.length, 3, 'write, delivery review, final: one child run only');
  assert.equal(readFileSync(join(f.directory, 'child.txt'), 'utf8'), 'verified child write');
  assert.equal(f.current().turns[0].delegations.length, 1); assert.equal(f.current().items.filter(row => row.kind === 'subagent').length, 1);
});

test('restart recovery marks running children interrupted, notifies once and refuses to re-run them', async t => {
  const f = await setup(t, async () => {}, { start: false });
  const handle = f.body(await f.call('agent_delegate', { task: 'Save the requested file.' }, 'crash-call'));
  await until(() => f.calls.length === 1);
  // A second process loads the persisted state while the first child never settled.
  const restarted = new Store(f.store.file), service = new BuiltinAgentService(restarted);
  t.after(() => service.close());
  const session = () => restarted.state.sessions.find(row => row.id === f.session.id);
  assert.equal(service.recover(), 1); assert.equal(service.recover(), 0);
  const record = service.record(f.session.id, handle.agentId);
  assert.equal(record.status, 'interrupted'); assert.equal(record.delivery.status, 'steered');
  assert.equal(session().inbox.filter(row => row.agentId === handle.agentId).length, 1); assert.match(session().inbox[0].text, /^\[Host notice · subagent interrupted\][^]*Reason: The service restarted while the subtask was running/);
  assert.equal(session().items.find(row => row.kind === 'subagent').subagent.status, 'interrupted');
  // The resumed parent turn replays its spawn call: the interrupted child is never re-run.
  restarted.mutate(state => { const row = state.sessions.find(item => item.id === f.session.id); row.status = 'running'; row.turns[0].status = 'running'; });
  const tool = service.createTools({ sessionId: f.session.id, turnId: f.turnId }).find(row => row.name === 'agent_delegate');
  await assert.rejects(tool.execute('crash-call', { task: 'Save the requested file.' }, new AbortController().signal), { code: 'delegation_unresolved' });
  assert.equal(f.calls.length, 1, 'no second paid run');
});

test('a child\'s model is recorded as it was spawned and shown to the user, never in the results the parent model reads', async t => {
  const child = gate();
  const f = await setup(t, async (_input, res) => { await child.held; stream(res, { text: 'Evidence: README mentions the API.' }); }, { start: false });
  const turn = () => f.current().turns.find(row => row.id === f.turnId), spawned = turn().modelConfig;
  const model = { providerId: spawned.providerId, modelId: spawned.modelId, name: spawned.name ?? spawned.modelId };
  const without = (row, label) => assert.equal(Object.hasOwn(row, 'model'), false, label);
  const handle = f.body(await f.call('agent_consult', { role: 'scout', task: 'Inspect.' }, 'model-call'));
  without(handle, 'the spawn handle');
  assert.deepEqual(turn().delegations[0].model, model, 'kept on the record');
  // The turn switches models while the child runs: the child keeps the model it was spawned with.
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).turns.find(row => row.id === f.turnId).modelConfig.modelId = 'switched-model'; });
  without(f.body(await f.call('agent_status', {})).agents[0], 'agent_status list');
  assert.deepEqual(f.service.list(f.session.id)[0].model, model, 'the user\'s list (GET …/agents)');
  assert.deepEqual(f.item(handle.agentId).subagent.model, model, 'the conversation item');
  child.release();
  const joined = f.body(await f.call('agent_wait', { agentIds: [handle.agentId], timeoutSeconds: 30 }));
  assert.equal(joined.agents[0].status, 'completed'); without(joined.agents[0], 'agent_wait');
  without(f.body(await f.call('agent_status', { agentId: handle.agentId })), 'agent_status one');
  without(f.body(await f.call('agent_cancel', { agentId: handle.agentId })), 'agent_cancel');
  assert.deepEqual(f.body(await f.service.cancel(f.session.id, handle.agentId, 'user')).model, model, 'the user\'s cancel route');
  assert.deepEqual(f.item(handle.agentId).subagent.model, model, 'settled, still the model it was spawned with');
  // The spawn call replayed after the child finished returns its handle, also without the model.
  const replayed = f.body(await f.call('agent_consult', { role: 'scout', task: 'Inspect.' }, 'model-call'));
  assert.equal(replayed.agentId, handle.agentId); without(replayed, 'the replayed handle'); assert.equal(f.calls.length, 1);
});

test('agent_merge is the parent\'s write tool and never given to a child; without isolation a worker shares the folder and says so', async t => {
  const f = await setup(t, async (input, res, { parent, count }) => {
    if (!parent) return stream(res, { text: 'Child finished; nothing else verified.' });
    if (count === 1) return stream(res, { tool: true, name: 'agent_delegate', args: { task: 'Save the requested file.' } });
    stream(res, { text: 'Started a worker.' });
  });
  const merge = f.tools.find(row => row.name === 'agent_merge');
  assert.deepEqual([merge.permission, merge.effect], ['write', 'write']);
  await until(() => f.current().turns[0].status === 'completed');
  assert.ok(f.calls.find(input => input.tools?.some(tool => tool.function.name === 'agent_consult')).tools.some(tool => tool.function.name === 'agent_merge'));
  assert.ok(f.calls.filter(input => !input.tools?.some(tool => tool.function.name === 'agent_consult')).every(input => !(input.tools ?? []).some(tool => tool.function.name === 'agent_merge')), 'no child gets it');
  const [record] = f.current().turns[0].delegations;
  await until(() => f.record(record.id).status !== 'running');
  // No engine wired (isolation off: not_ready): 0.62 behaviour, said in the receipt, on the card and in the notice.
  assert.deepEqual(f.record(record.id).merge, { status: 'shared_root', applyIds: [], reason: 'not_ready' });
  assert.deepEqual(f.item(record.id).subagent.merge, { status: 'shared_root', applyIds: [], reason: 'not_ready' });
  assert.equal(mergeLine(f.record(record.id)), 'It worked directly in your files (no isolated copy: not_ready).', 'the line its notice and joined result carry');
  const refused = await f.call('agent_merge', { agentId: record.id });
  assert.equal(refused.isError, true); assert.equal(refused.details.code, 'merge_shared_root');
  assert.deepEqual(f.service.pendingMerges(f.session.id), []);
});
