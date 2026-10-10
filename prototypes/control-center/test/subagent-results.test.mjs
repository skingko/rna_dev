import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../store.mjs';
import { BuiltinAgentService, agentView } from '../builtin-agent-service.mjs';
import { applyProjectPermissions } from '../project-permissions.mjs';
import { RuntimeController } from '../runtime-controller.mjs';
import { UsageLedger } from '../usage-cache-service.mjs';
import { SUBAGENT_RESULTS_KEY, SUBAGENT_RESULTS_SOURCE, claimedInbox, deliveredResults, owedResult, subagentResultsUpdate } from '../subagent-results.mjs';
import { prepareContext, summarySourceText } from '../../../packages/sdk/src/context.mjs';

// Plan A4 (align §1.3 B): a background subagent's result that settles when no running turn can take it reaches the
// parent model once, at the tail of the next request (`subagent-results`), and is then `reported` — no turn of its own.
// Also: the delegation texts the model reads are fixed English, a worker without write tools never starts, and the
// turn-end merge reminder (ISO-4) is not repeated for workers the model cannot act on or already heard about.
// Fixture HTTP model only; no paid calls.

async function until(check, ms = 20000) { const deadline = Date.now() + ms; while (!check()) { if (Date.now() > deadline) throw new Error('Fixture did not settle'); await delay(10); } }
function stream(res, { tool, name = 'agent_consult', id = `call-${name}`, args = {}, text = 'Fixture response; nothing else was verified.' } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const delta = tool ? { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { content: text };
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
}
const isParent = input => input.tools?.some(tool => tool.function.name === 'agent_consult');
const gate = () => { let release; const held = new Promise(resolve => { release = resolve; }); return { held, release }; };
const count = (text, needle) => text.split(needle).length - 1;
const CHILD_ANSWER = 'Scout found the entry point in src/index.js.';

async function setup(t, respond, { start = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rna-results-')), parents = [], counts = { parent: 0, child: 0 };
  const server = http.createServer(async (req, res) => { let raw = ''; for await (const part of req) raw += part; const input = JSON.parse(raw); const parent = isParent(input); if (parent) parents.push(input); counts[parent ? 'parent' : 'child']++; await respond(input, res, { parent, count: counts[parent ? 'parent' : 'child'] }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const store = new Store(join(directory, 'private', 'state.json')); store.usageLedger = new UsageLedger();
  const provider = store.configurationService.provider(null, { name: 'Fixture', protocol: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'results-fixture-secret', models: [{ id: 'fixture-model', contextWindow: 64000, maxOutputTokens: 512, reasoning: ['off'] }] });
  store.configurationService.update({ defaultModel: { providerId: provider.id, modelId: 'fixture-model', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const { session, project } = store.createProject({ name: 'Results fixture', workspace: directory, initiative: { enabled: false } });
  store.mutate(state => applyProjectPermissions(state, project.id, { workspace: 'execute', background: 'read' }));
  store.message(session.id, { text: 'Parent task', requestId: 'parent-request' });
  const current = () => store.state.sessions.find(item => item.id === session.id), turnId = current().activeTurnId;
  const service = new BuiltinAgentService(store), tools = service.createTools({ sessionId: session.id, turnId });
  const call = (name, args, id = `${name}-${Math.random()}`) => tools.find(row => row.name === name).execute(id, args, new AbortController().signal);
  const f = { directory, store, service, tools, call, parents, counts, session, project, turnId, current, executor: null,
    body: result => JSON.parse(result.content[0].text), record: id => service.record(session.id, id), item: id => current().items.find(row => row.kind === 'subagent' && row.subagent.agentId === id),
    start: () => { f.executor ??= new RuntimeController(store, { builtinAgentService: service }); return f.executor; },
    // A new user message, run to its end by the runtime.
    send: async (text, requestId = `send-${Math.random()}`) => { f.start(); const before = f.current().turns.length; store.message(session.id, { text, requestId }); await until(() => f.current().turns.length > before && f.current().turns.at(-1).status === 'completed' && !f.current().activeTurnId); return f.current().turns.at(-1); } };
  if (start) f.start();
  t.after(async () => { await f.executor?.close(); await service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  return f;
}
/** The parent requests' bodies as one string each. */
const wire = f => f.parents.map(input => JSON.stringify(input.messages));

test('a result that settles after its parent turn ended rides the next request once, is then reported, and starts no turn of its own', async t => {
  const child = gate();
  const f = await setup(t, async (_input, res, { parent, count: n }) => {
    if (!parent) { await child.held; return stream(res, { text: CHILD_ANSWER }); }
    if (n === 1) return stream(res, { tool: true, args: { role: 'scout', task: 'Find the entry point.' } });
    stream(res, { text: n === 2 ? 'I started a scout and will report when it returns.' : `Reply ${n}.` });
  });
  await until(() => f.current().turns[0].status === 'completed');
  const [{ id }] = f.current().turns[0].delegations;
  child.release(); await until(() => f.record(id).delivery?.status === 'noticed');
  assert.equal(f.counts.parent, 2, 'no paid request for the result itself'); assert.equal(f.current().turns.length, 1);
  assert.ok(!wire(f).some(text => text.includes(CHILD_ANSWER)), 'the model has not read it yet');

  const second = await f.send('What did the scout find?');
  const [, , third] = wire(f);
  assert.equal(count(third, CHILD_ANSWER), 1, 'the next request carries the result exactly once');
  assert.equal(count(third, SUBAGENT_RESULTS_SOURCE), 1);
  assert.match(third, /ended after the turn that could take their results/);
  assert.deepEqual(f.record(id).delivery, { status: 'reported', at: f.record(id).delivery.at, via: 'context', turnId: second.id });
  assert.equal(f.item(id).subagent.delivery, 'reported');
  assert.equal(f.counts.parent, 3, 'one request for the user\'s message, nothing else');

  await f.send('Thanks.');
  const fourth = wire(f)[3];
  assert.equal(count(fourth, CHILD_ANSWER), 1, 'later requests hold only the copy already in the history');
  assert.equal(count(fourth, SUBAGENT_RESULTS_SOURCE), 1, 'no second copy');
  assert.equal(f.counts.parent, 4);
});

test('a result steered into a turn that then ends without taking it is recorded as noticed, not steered, and reaches the next request', async t => {
  const f = await setup(t, async (input, res, { parent, count: n }) => {
    if (!parent) return stream(res, { text: CHILD_ANSWER });
    stream(res, { text: `Reply ${n}.` });
  }, { start: false });
  // The parent turn is running (no runtime yet), so the settled result is queued as steering for its next boundary.
  const handle = f.body(await f.call('agent_consult', { role: 'scout', task: 'Find the entry point.' }));
  await until(() => f.record(handle.agentId).delivery?.status === 'steered');
  assert.equal(f.current().inbox.filter(row => row.agentId === handle.agentId).length, 1);
  // The turn ends (its final reply streamed) before any boundary took it: a notice for the user only.
  f.store.finishRuntimeTurn(f.session.id, f.turnId);
  assert.equal(f.current().inbox.length, 0);
  assert.ok(f.current().items.some(row => row.kind === 'notice' && row.source === 'subagent' && row.agentId === handle.agentId));
  assert.equal(f.record(handle.agentId).delivery.status, 'noticed', 'the record does not claim the model was steered');
  assert.equal(f.item(handle.agentId).subagent.delivery, 'noticed');

  await f.send('Go on.');
  assert.equal(f.counts.parent, 1);
  assert.equal(count(wire(f)[0], CHILD_ANSWER), 1);
  assert.equal(f.record(handle.agentId).delivery.status, 'reported');
});

// The runtime may already have handed the steering message to the SDK queue when the turn completes (it ended before a
// boundary took it). The next run withdraws a steer left in the queue: the record must not still claim `steered`.
test('a steering notice already in the SDK queue when its turn completed is noticed, and the next request carries it', async t => {
  const f = await setup(t, async (_input, res, { parent, count: n }) => stream(res, { text: parent ? `Reply ${n}.` : CHILD_ANSWER }), { start: false });
  const handle = f.body(await f.call('agent_consult', { role: 'scout', task: 'Find the entry point.' }));
  await until(() => f.record(handle.agentId).delivery?.status === 'steered');
  f.store.mutate(state => { const row = state.sessions.find(item => item.id === f.session.id).inbox.find(item => item.agentId === handle.agentId); row.deliveryStatus = 'accepted'; row.runtimeInboxId = 'sdk-steer-1'; });
  f.store.finishRuntimeTurn(f.session.id, f.turnId);
  assert.equal(f.current().inbox.length, 0);
  assert.deepEqual([f.record(handle.agentId).delivery.status, f.record(handle.agentId).delivery.runtimeInboxId], ['noticed', 'sdk-steer-1']);
  const next = await f.send('Go on.');
  assert.equal(f.counts.parent, 1);
  assert.equal(count(wire(f)[0], CHILD_ANSWER), 1, 'the model gets it once, as context');
  assert.deepEqual([f.record(handle.agentId).delivery.status, f.record(handle.agentId).delivery.via, f.record(handle.agentId).delivery.turnId], ['reported', 'context', next.id]);
});

// An observation left in the SDK queue is taken by the next run before its first request: the journal holds it then.
test('a steering notice a later run took from the SDK queue is not repeated as context; once a rewind cuts that turn it is offered again', async t => {
  const f = await setup(t, async (_input, res, { parent }) => stream(res, { text: parent ? 'Reply.' : CHILD_ANSWER }), { start: false });
  const handle = f.body(await f.call('agent_consult', { role: 'scout', task: 'Find the entry point.' }));
  await until(() => f.record(handle.agentId).delivery?.status === 'steered');
  f.store.mutate(state => { const row = state.sessions.find(item => item.id === f.session.id).inbox.find(item => item.agentId === handle.agentId); row.deliveryStatus = 'accepted'; row.runtimeInboxId = 'sdk-observation-1'; });
  f.store.finishRuntimeTurn(f.session.id, f.turnId);
  assert.equal(f.record(handle.agentId).delivery.status, 'noticed');
  const claimed = claimedInbox([{ id: 'm1', role: 'user', source: 'user', content: [] }, { id: 'm2', role: 'user', source: 'observation', inboxId: 'sdk-observation-1', content: [] }]);
  assert.deepEqual([...claimed], ['sdk-observation-1']);
  assert.equal(f.service.resultsUpdate(f.session.id, { turnId: 'turn-next', delivered: new Set(), claimed }), null, 'no second copy');
  const { status, via, turnId, runtimeInboxId } = f.record(handle.agentId).delivery;
  assert.deepEqual({ status, via, turnId, runtimeInboxId }, { status: 'reported', via: 'steer', turnId: 'turn-next', runtimeInboxId: 'sdk-observation-1' });
  assert.equal(f.item(handle.agentId).subagent.delivery, 'reported');
  // That turn is gone (a rewind cut it, and the claimed message with it): owed again, as context this time.
  const again = f.service.resultsUpdate(f.session.id, { turnId: f.turnId, delivered: new Set(), claimed: new Set() });
  assert.equal(count(again.text, CHILD_ANSWER), 1);
  assert.deepEqual([f.record(handle.agentId).delivery.status, f.record(handle.agentId).delivery.via, f.record(handle.agentId).delivery.turnId], ['reported', 'context', f.turnId]);
});

test('rewind: cutting the request that carried a result offers it again once; cutting the turn that started it removes it', async t => {
  const child = gate();
  const f = await setup(t, async (_input, res, { parent, count: n }) => {
    if (!parent) { await child.held; return stream(res, { text: CHILD_ANSWER }); }
    if (n === 1) return stream(res, { tool: true, args: { role: 'scout', task: 'Find the entry point.' } });
    stream(res, { text: `Reply ${n}.` });
  });
  await until(() => f.current().turns[0].status === 'completed');
  const [{ id }] = f.current().turns[0].delegations;
  child.release(); await until(() => f.record(id).delivery?.status === 'noticed');
  const carried = await f.send('What did it find?');
  assert.equal(count(wire(f)[2], CHILD_ANSWER), 1);
  assert.equal(f.record(id).delivery.turnId, carried.id);
  // The user edits the message of the turn that carried it: that request leaves the model's context.
  await f.executor.rewind(f.session.id, carried.userItemId);
  assert.ok(!f.current().turns.some(row => row.id === carried.id));
  await f.send('What did it find, again?');
  assert.equal(count(wire(f)[3], CHILD_ANSWER), 1, 'offered once more, since the model no longer holds it');
  assert.equal(count(wire(f)[3], SUBAGENT_RESULTS_SOURCE), 1, 'the cut copy is gone from the history');
  // Cutting the turn that started it takes its record along: nothing is owed any more.
  await f.executor.rewind(f.session.id, f.current().turns[0].userItemId);
  assert.equal(f.record(id), undefined);
  await f.send('Start over.');
  assert.equal(count(wire(f).at(-1), CHILD_ANSWER), 0);
  assert.equal(count(wire(f).at(-1), SUBAGENT_RESULTS_SOURCE), 0);
});

// Review subagents-steered-not-reoffered-after-rewind: a result steered into a later turn, taken at its boundary, then
// cut by a rewind of that turn, is offered again like one that rode the results context.
test('a result a later turn took as steering is offered again once a rewind cuts that turn', async t => {
  const child = gate(), childDone = gate();
  const f = await setup(t, async (_input, res, { parent, count: n }) => {
    if (!parent) { await child.held; return stream(res, { text: CHILD_ANSWER }); }
    if (n === 1) return stream(res, { tool: true, args: { role: 'scout', task: 'Find the entry point.' } });
    if (n === 2) return stream(res, { text: 'Started a scout.' });
    // The second turn's first request: a read-only tool call, answered once the child settled (steered into that turn).
    if (n === 3) { await childDone.held; return stream(res, { tool: true, name: 'project_list', id: 'call-list', args: {} }); }
    stream(res, { text: `Reply ${n}.` });
  });
  await until(() => f.current().turns[0].status === 'completed');
  const [{ id }] = f.current().turns[0].delegations;
  f.store.message(f.session.id, { text: 'Meanwhile, look at X.', requestId: 'second' });
  await until(() => f.counts.parent === 3);
  child.release(); await until(() => f.record(id).delivery?.status === 'steered');
  childDone.release();
  await until(() => f.current().turns.length === 2 && f.current().turns[1].status === 'completed' && !f.current().activeTurnId);
  const second = f.current().turns[1], taken = f.record(id).delivery;
  assert.equal(count(wire(f)[3], CHILD_ANSWER), 1, 'the second turn took it at its boundary');
  assert.equal(taken.status, 'steered'); assert.equal(taken.turnId, second.id); assert.equal(typeof taken.runtimeInboxId, 'string', 'the record names the message that carries it');
  assert.equal(f.item(id).subagent.delivery, 'steered');
  // While the journal holds it, later requests do not repeat it.
  await f.send('And Y?');
  assert.equal(count(wire(f).at(-1), CHILD_ANSWER), 1, 'only the steering message in the history');
  assert.equal(count(wire(f).at(-1), SUBAGENT_RESULTS_SOURCE), 0);
  // The user edits the second turn's message: the steering message leaves the model's context with it.
  await f.executor.rewind(f.session.id, second.userItemId);
  assert.ok(f.current().turns.some(row => row.id === f.current().turns[0].id) && !f.current().turns.some(row => row.id === second.id));
  const before = f.counts.parent, next = await f.send('Look at X again.');
  const sent = wire(f).slice(before);
  assert.equal(count(sent[0], CHILD_ANSWER), 1, 'offered again, once');
  assert.equal(count(sent[0], SUBAGENT_RESULTS_SOURCE), 1);
  assert.deepEqual([f.record(id).delivery.status, f.record(id).delivery.via, f.record(id).delivery.turnId], ['reported', 'context', next.id]);
});

// The same for a result that opened a follow-up turn (continueAfter): a rewind that removes that turn makes it owed.
test('a result whose follow-up turn a rewind removed is offered again; one that waited for its turn to end opens the next turn as woke', async t => {
  const child = gate();
  const f = await setup(t, async (_input, res, { parent, count: n }) => {
    if (!parent) { await child.held; return stream(res, { text: CHILD_ANSWER }); }
    if (n === 1) return stream(res, { tool: true, args: { role: 'scout', task: 'Find the entry point.', continueAfter: true } });
    stream(res, { text: `Reply ${n}.` });
  });
  await until(() => f.current().turns[0].status === 'completed');
  const [{ id }] = f.current().turns[0].delegations;
  const asked = await f.send('Meanwhile, look at X.');
  child.release();
  await until(() => f.current().turns.length === 3 && f.current().turns[2].status === 'completed' && !f.current().activeTurnId);
  const woke = f.current().turns[2];
  assert.deepEqual([f.record(id).delivery.status, f.record(id).delivery.turnId], ['woke', woke.id]);
  assert.equal(f.current().items.find(row => row.id === woke.userItemId).source, 'subagent');
  assert.equal(count(wire(f).at(-1), CHILD_ANSWER), 1, 'the follow-up turn\'s prompt carries it');
  // The user edits the message sent while the scout ran: that turn and the follow-up after it are cut, the scout's stays.
  await f.executor.rewind(f.session.id, asked.userItemId);
  assert.deepEqual(f.current().turns.map(row => row.id), [f.current().turns[0].id]);
  const before = f.counts.parent, next = await f.send('Look at X again.');
  assert.equal(count(wire(f)[before], CHILD_ANSWER), 1, 'offered again, once');
  assert.deepEqual([f.record(id).delivery.status, f.record(id).delivery.via, f.record(id).delivery.turnId], ['reported', 'context', next.id]);
});

test('a wake result queued as steering for a turn that completes first opens the next turn, and its record says woke with that turn', async t => {
  const f = await setup(t, async (_input, res, { parent, count: n }) => stream(res, { text: parent ? `Reply ${n}.` : CHILD_ANSWER }), { start: false });
  const handle = f.body(await f.call('agent_consult', { role: 'scout', task: 'Find the entry point.', continueAfter: true }));
  await until(() => f.record(handle.agentId).delivery?.status === 'steered');
  assert.equal(f.current().inbox.find(row => row.agentId === handle.agentId)?.wake, true);
  f.store.finishRuntimeTurn(f.session.id, f.turnId);
  const opened = f.current().turns[1];
  assert.ok(opened && f.current().activeTurnId === opened.id, 'the queued result opened the follow-up turn');
  assert.deepEqual([f.record(handle.agentId).delivery.status, f.record(handle.agentId).delivery.turnId], ['woke', opened.id]);
  assert.equal(f.item(handle.agentId).subagent.delivery, 'woke');
  assert.equal(f.service.resultsUpdate(f.session.id, { turnId: opened.id, delivered: new Set(), claimed: new Set() }), null, 'its own prompt carries it');
});

// A stop takes back the turn's queued messages. A result queued to wake the parent (continueAfter) is not the user's
// message: it becomes a notice like any other result its turn could not take, and the next request carries it.
test('a wake result still queued when the user stops the turn is noticed, and the next request carries it', async t => {
  const f = await setup(t, async (_input, res, { parent, count: n }) => stream(res, { text: parent ? `Reply ${n}.` : CHILD_ANSWER }), { start: false });
  const handle = f.body(await f.call('agent_consult', { role: 'scout', task: 'Find the entry point.', continueAfter: true }));
  await until(() => f.record(handle.agentId).delivery?.status === 'steered');
  assert.equal(f.current().inbox.find(row => row.agentId === handle.agentId)?.wake, true);
  // A host notice about the same subagent that is not its result (as 让 Rna 处理 queues one) waits behind it.
  assert.equal(f.store.deliverAgentNotice(f.session.id, { agentId: handle.agentId, turnId: f.turnId, prompt: '[Host notice · worker merge] Settle it.', notice: 'Handoff notice line', wake: true, track: false })?.status, 'steered');
  assert.equal(f.record(handle.agentId).delivery.status, 'steered', 'that notice leaves the record alone');
  f.store.controlSession(f.session.id, 'stop');
  assert.equal(f.current().inbox.length, 0);
  assert.equal(f.record(handle.agentId).delivery.status, 'noticed');
  const notices = f.current().items.filter(row => row.kind === 'notice' && row.source === 'subagent' && row.agentId === handle.agentId);
  assert.equal(notices.length, 1, 'the user is told of the result once');
  assert.notEqual(notices[0].text, 'Handoff notice line', 'the host notice is taken back with the queue, not shown as a result');
  const next = await f.send('Go on.');
  assert.equal(count(wire(f)[0], CHILD_ANSWER), 1);
  assert.deepEqual([f.record(handle.agentId).delivery.status, f.record(handle.agentId).delivery.via, f.record(handle.agentId).delivery.turnId], ['reported', 'context', next.id]);
});

// Review subagents-stop-during-hook-loses-result: the user stops the next turn while its first request is still being
// prepared; nothing reached the model, so the result is still owed to the request after.
test('a stop while the next turn\'s first request is prepared leaves the result owed; the following turn carries it once', async t => {
  const child = gate();
  const f = await setup(t, async (_input, res, { parent, count: n }) => {
    if (!parent) { await child.held; return stream(res, { text: CHILD_ANSWER }); }
    if (n === 1) return stream(res, { tool: true, args: { role: 'scout', task: 'Find the entry point.' } });
    stream(res, { text: `Reply ${n}.` });
  });
  await until(() => f.current().turns[0].status === 'completed');
  const [{ id }] = f.current().turns[0].delegations;
  child.release(); await until(() => f.record(id).delivery?.status === 'noticed');
  // The first request of the next turn prepares slowly (routing, mind context); the user stops the turn meanwhile.
  const original = f.executor.prepareRequest.bind(f.executor), hold = gate(); let entered = false, finished = false;
  f.executor.prepareRequest = async (context, input) => { if (!entered) { entered = true; await hold.held; try { return await original(context, input); } finally { finished = true; } } return original(context, input); };
  f.store.message(f.session.id, { text: 'What did it find?', requestId: 'second' });
  await until(() => entered);
  const stopped = f.current().activeTurnId;
  f.store.controlSession(f.session.id, 'stop');
  hold.release();
  await until(() => finished && !f.current().activeTurnId && f.current().turns.find(row => row.id === stopped)?.status === 'stopped');
  assert.equal(f.counts.parent, 2, 'the stopped turn sent nothing');
  assert.equal(f.record(id).delivery.status, 'noticed', 'an abandoned hook marks nothing');
  const next = await f.send('And now?');
  const carried = wire(f).filter(text => text.includes(CHILD_ANSWER));
  assert.equal(carried.length, 1); assert.equal(count(carried[0], CHILD_ANSWER), 1);
  assert.deepEqual([f.record(id).delivery.status, f.record(id).delivery.via, f.record(id).delivery.turnId], ['reported', 'context', next.id]);
  // A copy marked for a turn that is still listed but never reached the journal (a hook abandoned after it marked, a
  // payload the SDK refused) is owed again on the next request too: the journal decides, not the turn on the record.
  f.store.mutate(state => { const row = state.sessions.find(item => item.id === f.session.id).turns[0].delegations[0]; row.delivery = { ...row.delivery, turnId: stopped }; });
  const again = f.service.resultsUpdate(f.session.id, { turnId: 'turn-later', delivered: new Set(), claimed: new Set() });
  assert.equal(count(again?.text ?? '', CHILD_ANSWER), 1);
});

// Review subagents-handoff-drops-noticed-result: 让 Rna 处理 is a host notice about the worker, not its result.
test('让 Rna 处理 on a worker whose result was only noticed: the turn it opens carries the report once; the delivery is left alone', async t => {
  const f = await setup(t, async (_input, res, { count: n }) => stream(res, { text: `Reply ${n}.` }), { start: false });
  const at = new Date().toISOString(), report = 'Worker changed src/a.js and src/b.js; test/a.test.js still fails on Windows paths.', read = 'Second worker renamed the helper.';
  const worker = (id, output, delivery, merge) => ({ id, role: 'worker', fingerprint: id, status: 'completed', task: 'Fix path handling.', output, summary: output, background: true, createdAt: at, startedAt: at, endedAt: at, completedAt: at, usage: { totalTokens: 0 }, delivery, worktree: { id: `w-${id}` }, merge });
  // The first ended while the conversation was idle: merged all or nothing (a conflict, nothing written), shown to the
  // user only. The model read the second one's result with agent_status.
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).turns[0].delegations = [
    worker('agent-w1', report, { status: 'noticed', at }, { status: 'conflict', applyIds: [], files: 0, conflicts: [{ path: 'src/a.js', kind: 'content' }] }),
    worker('agent-w2', read, { status: 'reported', at, via: 'read' }, { status: 'pending', applyIds: [], reason: 'cancelled' })]; });
  f.store.finishRuntimeTurn(f.session.id, f.turnId);
  f.start();
  const handed = await f.service.userMerge(f.session.id, 'agent-w1', { action: 'handoff' });
  assert.deepEqual(f.record('agent-w1').delivery, { status: 'noticed', at }, 'the notice is not the result');
  await until(() => f.current().turns.length === 2 && f.current().turns[1].status === 'completed' && !f.current().activeTurnId);
  const opened = f.current().turns[1];
  assert.equal(handed.turnId, opened.id);
  const [first] = wire(f);
  assert.match(first, /Host notice · worker merge\] The user asked you to settle the changes of worker agent-w1/);
  assert.equal(count(first, 'Windows paths'), 1, 'the worker\'s own report rides the request of the turn it opened');
  assert.ok(wire(f).every(text => count(text, 'Windows paths') <= 1), 'never twice');
  assert.deepEqual([f.record('agent-w1').delivery.status, f.record('agent-w1').delivery.via, f.record('agent-w1').delivery.turnId], ['reported', 'context', opened.id]);
  // A worker whose result the model already has: only the notice goes, the record stays as it was.
  const before = f.counts.parent;
  await f.service.userMerge(f.session.id, 'agent-w2', { action: 'handoff' });
  await until(() => f.current().turns.length === 3 && f.current().turns[2].status === 'completed' && !f.current().activeTurnId);
  assert.deepEqual(f.record('agent-w2').delivery, { status: 'reported', at, via: 'read' });
  assert.match(wire(f)[before], /settle the changes of worker agent-w2/);
  assert.equal(count(wire(f)[before], read), 0, 'not sent again');
  assert.equal(count(wire(f)[before], SUBAGENT_RESULTS_SOURCE), 1, 'only the first worker\'s copy, in the history');
});

test('compaction: the copy is window-scoped and accumulating — never restored after a summary, kept in the summary record, never offered again', () => {
  const entry = { agentId: 'agent-1', role: 'scout', status: 'completed', task: 'Find it.', summary: CHILD_ANSWER };
  const { update, agentIds } = subagentResultsUpdate([entry]);
  assert.deepEqual(agentIds, ['agent-1']);
  assert.deepEqual({ key: update.key, source: update.source, scope: update.scope, accumulates: update.accumulates }, { key: SUBAGENT_RESULTS_KEY, source: SUBAGENT_RESULTS_SOURCE, scope: 'window', accumulates: true });
  assert.doesNotMatch(update.text, /[一-鿿]/);
  const user = (id, text) => ({ id, role: 'user', source: 'user', content: [{ type: 'text', text }] });
  const assistant = (id, text) => ({ id, role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' });
  const results = { id: 'ctx-1', role: 'user', source: 'context', content: [{ type: 'text', text: 'context' }], context: [{ source: update.source, text: update.text }], contextKey: update.key, contextRevision: 'r1', contextScope: 'window', contextAccumulates: true };
  const messages = [user('u1', 'first'), results, assistant('a1', 'ok'), user('u2', 'second'), assistant('a2', 'ok')];
  const projected = prepareContext({ sessionId: 's', projectId: 'p', messages, compaction: { id: 'c1', throughMessageId: 'a1', summary: 'Summary.' } }).messages;
  assert.ok(!JSON.stringify(projected).includes(CHILD_ANSWER), 'a summary is not followed by an old result reading as news');
  assert.ok(summarySourceText({ messages: messages.slice(0, 3) }).includes(CHILD_ANSWER), 'the summary request reads it');
  // The journal still lists it, so it is not owed again.
  const delivered = deliveredResults(messages);
  assert.deepEqual([...delivered], ['agent-1']);
  assert.equal(owedResult({ id: 'agent-1', status: 'completed', delivery: { status: 'reported', via: 'context', turnId: 't2' } }, { turnId: 't2', turnIds: new Set(['t2']), delivered }), false);
  assert.equal(owedResult({ id: 'agent-1', status: 'completed', delivery: { status: 'noticed' } }, { turnId: 't3', turnIds: new Set(['t2', 't3']), delivered }), false);
  // Without it in the journal: owed when noticed, or when the message that carried it is not in the journal either,
  // whatever turn the record names: a rewind cut it, or it was never sent (a request hook the user's stop abandoned,
  // its turn still listed). Not when the model read it with agent_status, or a message still holds it.
  const none = new Set();
  assert.equal(owedResult({ id: 'x', status: 'completed', delivery: { status: 'noticed' } }, { turnId: 't3', turnIds: new Set(['t3']), delivered: none }), true);
  assert.equal(owedResult({ id: 'x', status: 'completed', delivery: { status: 'reported', via: 'context', turnId: 'gone' } }, { turnId: 't3', turnIds: new Set(['t3']), delivered: none }), true);
  assert.equal(owedResult({ id: 'x', status: 'completed', delivery: { status: 'reported', via: 'context', turnId: 't2' } }, { turnId: 't3', turnIds: new Set(['t2', 't3']), delivered: none }), true, 'marked in t2, never in the journal');
  assert.equal(owedResult({ id: 'x', status: 'completed', delivery: { status: 'reported', via: 'read' } }, { turnId: 't3', turnIds: new Set(['t3']), delivered: none }), false);
  assert.equal(owedResult({ id: 'x', status: 'running', delivery: { status: 'noticed' } }, { turnId: 't3', turnIds: new Set(['t3']), delivered: none }), false);
  // Steered: owed only once taken by a run (its SDK queue id on the record) and no longer in the journal.
  const steered = { id: 'x', status: 'completed', delivery: { status: 'steered', inboxId: 'q1', turnId: 't2', runtimeInboxId: 'sdk-1' } };
  assert.equal(owedResult(steered, { turnId: 't3', turnIds: new Set(['t2', 't3']), delivered: none, claimed: new Set(['sdk-1']) }), false);
  assert.equal(owedResult(steered, { turnId: 't3', turnIds: new Set(['t3']), delivered: none, claimed: new Set() }), true);
  assert.equal(owedResult({ id: 'x', status: 'completed', delivery: { status: 'steered', inboxId: 'q1' } }, { turnId: 't3', turnIds: new Set(['t3']), delivered: none }), false, 'still queued');
  // Woke: owed once the follow-up turn its prompt opened is gone.
  const woke = { id: 'x', status: 'completed', delivery: { status: 'woke', turnId: 'tw' } };
  assert.equal(owedResult(woke, { turnId: 'tw', turnIds: new Set(['tw']), delivered: none }), false, 'its own turn carries it');
  assert.equal(owedResult(woke, { turnId: 't4', turnIds: new Set(['tw', 't4']), delivered: none }), false);
  assert.equal(owedResult(woke, { turnId: 't4', turnIds: new Set(['t4']), delivered: none }), true);
});

test('agent_status reading a noticed result settles it: the next request does not carry it again', async t => {
  const f = await setup(t, async (_input, res, { parent }) => stream(res, { text: parent ? 'Reply.' : CHILD_ANSWER }), { start: false });
  const handle = f.body(await f.call('agent_consult', { role: 'scout', task: 'Find the entry point.' }));
  await until(() => f.record(handle.agentId).delivery?.status === 'steered');
  f.store.finishRuntimeTurn(f.session.id, f.turnId);
  assert.equal(f.record(handle.agentId).delivery.status, 'noticed');
  assert.match(f.body(await f.call('agent_status', { agentId: handle.agentId })).output, /entry point/);
  assert.deepEqual([f.record(handle.agentId).delivery.status, f.record(handle.agentId).delivery.via], ['reported', 'read']);
  await f.send('Next.');
  assert.equal(count(wire(f)[0], CHILD_ANSWER), 0);
});

test('a worker composed without write tools fails before any request; its record says delegation_permission', async t => {
  const f = await setup(t, async (_input, res) => stream(res), { start: false });
  let prompted = 0;
  f.service.factory = async () => ({ snapshot: () => ({ tools: ['project_read', 'project_list'], messages: [], recovery: { interrupted: false, pendingTools: 0, pendingFinish: false, uncertainTools: [] }, queue: { steering: [] }, usage: { totalTokens: 0 } }),
    async prompt() { prompted++; }, async resume() {}, async steer() {}, async dispose() {}, async abort() {} });
  const handle = f.body(await f.call('agent_delegate', { task: 'Save the requested file.' }));
  await until(() => f.record(handle.agentId).status !== 'running');
  assert.equal(f.record(handle.agentId).status, 'failed'); assert.equal(f.record(handle.agentId).code, 'delegation_permission');
  assert.equal(prompted, 0); assert.equal(f.counts.child, 0, 'no model request');
  // Said as what happened (it never started), not as a permission withdrawn mid-run.
  assert.equal(f.record(handle.agentId).summary, '这个实现子任务拿不到写文件的工具，所以没有开始，也没有发出模型请求；未自动重试。');
  await until(() => f.current().inbox.some(row => row.agentId === handle.agentId));
  assert.match(f.current().inbox.find(row => row.agentId === handle.agentId).text, /\nReason: This implementation subtask had no file write tools, so it was not started and made no model request\. It was not retried\.\n/);
});

test('what the parent model reads from the delegation tools is English: refusals, handles and the result envelope', async t => {
  const child = gate();
  const f = await setup(t, async (_input, res) => { await child.held; stream(res, { text: CHILD_ANSWER }); }, { start: false });
  const cjk = /[一-鿿]/;
  const handle = f.body(await f.call('agent_consult', { role: 'scout', task: '找到入口文件。' }));
  assert.match(handle.next, /^Running in the background\. [^]*at the start of the next turn\. If your answer needs this result, call agent_wait before you answer\.$/);
  const failures = [];
  const catchText = async promise => { try { const result = await promise; return result.content?.[0]?.text ?? ''; } catch (error) { failures.push(error.code); return error.message; } };
  const texts = [
    await catchText(f.call('agent_status', { agentId: 'agent-missing' })),
    await catchText(f.call('agent_wait', { agentIds: ['agent-missing'], timeoutSeconds: 1 })),
    await catchText(f.call('agent_message', { agentId: 'agent-missing', message: '补充' })),
    await catchText(f.call('agent_cancel', { agentId: 'agent-missing' })),
    f.body(await f.call('agent_wait', { agentIds: [handle.agentId], timeoutSeconds: 1 })).note
  ];
  assert.deepEqual(failures, ['delegation_unknown', 'delegation_unknown', 'delegation_unknown', 'delegation_unknown']);
  // The model's view of a child (handle, agent_status, agent_wait, agent_cancel) has no interface-language label or
  // reason: `role` names it, and one that ended without a result says why in English. The user's record keeps both.
  const own = ({ task, output, ...rest }) => rest;
  const views = [handle, ...f.body(await f.call('agent_wait', { agentIds: [handle.agentId], timeoutSeconds: 1 })).agents];
  const second = f.body(await f.call('agent_consult', { role: 'planner', task: 'Plan it.' }));
  const cancelled = f.body(await f.call('agent_cancel', { agentId: second.agentId }));
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.summary, 'The subtask was cancelled; steps it already finished are not rolled back.');
  views.push(second, cancelled, f.body(await f.call('agent_status', { agentId: second.agentId })), ...f.body(await f.call('agent_status', {})).agents);
  for (const view of views) { assert.equal(view.roleName, undefined); assert.doesNotMatch(JSON.stringify(own(view)), cjk, JSON.stringify(view)); }
  const shown = agentView(f.record(second.agentId));
  assert.deepEqual([shown.roleName, shown.summary], ['方案规划', '子任务已取消；已完成的操作不会回滚。'], "the user's view follows the interface language");
  child.release(); await until(() => f.record(handle.agentId).status === 'completed');
  texts.push(f.body(await f.call('agent_message', { agentId: handle.agentId, message: 'More.' })).reason);
  f.store.mutate(state => { state.sessions.find(row => row.id === f.session.id).turns[0].mode = 'plan'; });
  texts.push(await catchText(f.call('agent_delegate', { task: 'Write it.' })));
  for (const text of texts) { assert.ok(text, 'a text'); assert.doesNotMatch(text, cjk, text); }
  // The notice queued for the running turn: English for the model, the interface language for the user's line.
  const queued = f.current().inbox.find(row => row.agentId === handle.agentId);
  assert.match(queued.text, /^\[Host notice · subagent finished\] agentId=agent-[0-9a-f]+ role=scout status=completed\nTask: 找到入口文件。\nResult: Scout found the entry point in src\/index\.js\.\nThis is a background subtask result forwarded by the host/);
  assert.doesNotMatch(queued.text.replace('找到入口文件。', ''), cjk);
  assert.match(queued.notice, /^子代理完成：项目侦察/);
  // Its finished view (reading it settles the notice above).
  assert.doesNotMatch(JSON.stringify(own(f.body(await f.call('agent_status', { agentId: handle.agentId })))), cjk);
});

test('ISO-4: the turn-end reminder skips workers the model cannot act on and names a worker again only once its merge changed', async t => {
  const f = await setup(t, async (_input, res, { count: n }) => stream(res, { text: `Reply ${n}.` }), { start: false });
  const at = new Date().toISOString();
  f.store.mutate(state => {
    const turn = state.sessions.find(row => row.id === f.session.id).turns[0];
    turn.delegations = [{ id: 'agent-held', role: 'worker', fingerprint: 'fp', status: 'cancelled', task: 'Edit a.txt.', background: true, createdAt: at, startedAt: at, endedAt: at, usage: { totalTokens: 0 }, delivery: { status: 'reported', at, via: 'read' }, worktree: { id: 'w-1' }, merge: { status: 'pending', applyIds: [], reason: 'cancelled' } }];
  });
  f.store.finishRuntimeTurn(f.session.id, f.turnId);
  // Requests that end with the reminder (later requests hold it in their history).
  const reminded = () => f.parents.filter(input => JSON.stringify(input.messages.at(-1)).includes('These workers ended, but their changes are not in your files yet')).length;
  const requestsOf = async text => { const before = f.counts.parent; await f.send(text); return f.counts.parent - before; };
  assert.equal(await requestsOf('One.'), 2, 'reminded once: one continuation');
  assert.equal(reminded(), 1);
  assert.ok(f.record('agent-held').mergeReminder?.remindedAt);
  assert.equal(await requestsOf('Two.'), 1, 'the same merge state is not pointed out again');
  assert.equal(reminded(), 1);
  // The merge changed (the user merged it from the card and a file conflicts now): pointed out once more.
  f.store.mutate(state => { const row = state.sessions.find(item => item.id === f.session.id).turns[0].delegations[0]; row.merge = { status: 'conflict', applyIds: ['a1'], conflicts: [{ path: 'a.txt', kind: 'content' }], files: 1 }; });
  assert.equal(await requestsOf('Three.'), 2);
  // A project that may not be changed: agent_merge would refuse, so no continuation is spent on it, whatever changed.
  f.store.mutate(state => { applyProjectPermissions(state, f.project.id, { workspace: 'read', background: 'read' }); const row = state.sessions.find(item => item.id === f.session.id).turns[0].delegations[0]; row.merge = { status: 'pending', applyIds: ['a1'], reason: 'read_only' }; });
  assert.equal(await requestsOf('Four.'), 1);
  assert.equal(reminded(), 2);
});
