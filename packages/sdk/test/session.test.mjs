import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { openJournal } from '../src/journal.mjs';
import { prepareContext } from '../src/context.mjs';

const model = { providerId: 'test', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 32000, maxOutputTokens: 1000, reasoning: 'off' };
const answer = async function* () { yield { type: 'text_delta', delta: 'done' }; yield { type: 'done', stopReason: 'stop' }; };
const text = message => message.content?.filter(part => part.type === 'text').map(part => part.text).join('');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tool = (execute, options = {}) => ({ name: 'lookup', description: 'Read fixture', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }, effect: 'read', execute, ...options });
async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-session-'));
  const args = { sessionId: 'session-one', projectId: 'project-one', cwd: dir, stateDir: join(dir, 'state'), model, provider: answer, ...options };
  const handles = [];
  const create = async override => { const handle = await createSession({ ...args, ...override }); handles.push(handle); return handle; };
  t.after(async () => { await Promise.allSettled(handles.map(handle => handle.dispose())); await rm(dir, { recursive: true, force: true }); });
  return { dir, args, create, session: await create() };
}

test('stream events, observed usage and stable cache identity survive reopening', async t => {
  const events = [], requests = [];
  const { session, create } = await setup(t, { onEvent: event => events.push(event), provider: async function* (request) { requests.push(request); yield { type: 'text_delta', delta: 'hello ' }; yield { type: 'text_delta', delta: 'world' }; yield { type: 'usage', usage: { input: 8, output: 3, cacheRead: 10, cacheWrite: 2, totalTokens: 23 } }; yield { type: 'done' }; } });
  await session.prompt('first'); const first = session.snapshot(); await session.dispose();
  const again = await create({ sessionFile: first.sessionFile }); await again.prompt('second');
  assert.equal(text(again.snapshot().messages.at(-1)), 'hello world');
  assert.equal(again.snapshot().usage.totalTokens, 46);
  assert.equal(requests[0].cache.sessionKey, requests[1].cache.sessionKey);
  assert.equal(requests[0].cache.prefixHash, requests[1].cache.prefixHash);
  assert.equal(requests[1].messages.length, 3);
  assert.ok(events.some(event => event.type === 'agent_settled'));
  // seq is the journal position of the record carrying the event: tokens of
  // one coalesced stream segment share their segment's seq.
  for (let i = 1; i < events.length; i++) assert.ok(events[i].type === 'message_update' && events[i - 1].type === 'message_update' ? events[i].seq >= events[i - 1].seq : events[i].seq > events[i - 1].seq);
  assert.equal((await stat(first.sessionFile)).mode & 0o777, 0o600);
});

test('tool arguments are validated before execution and unassigned tools are denied', async t => {
  let executions = 0, requests = 0;
  const { session } = await setup(t, { tools: [tool(async () => { executions++; return 'ok'; })], provider: async function* (request) {
    if (!requests++) {
      yield { type: 'tool_call', id: 'bad', name: 'lookup', arguments: { query: 3 } };
      yield { type: 'tool_call', id: 'unknown', name: 'forbidden', arguments: {} };
      yield { type: 'tool_call', id: 'good', name: 'lookup', arguments: { query: 'valid' } };
    } else assert.deepEqual(request.messages.filter(message => message.role === 'toolResult').map(message => message.isError), [true, true, false]);
    yield { type: 'done' };
  } });
  await session.prompt('read'); assert.equal(executions, 1); assert.equal(requests, 2);
});

test('turn reference attachments reach the provider without changing user text or cached prefix and survive reopening', async t => {
  const requests = [];
  const { session, create } = await setup(t, { provider: async function* (request) { requests.push(request); yield { type: 'text_delta', delta: 'answer' }; yield { type: 'done' }; } });
  const prefix = session.snapshot().cache.prefixHash;
  const context = [{ source: 'project-memory', text: 'related reference only' }];
  await session.prompt('user wording', { context });
  context[0].text = 'caller mutation';
  const snapshot = session.snapshot(), user = snapshot.messages.find(message => message.role === 'user');
  assert.equal(text(user), 'user wording'); assert.equal(user.context[0].text, 'related reference only');
  assert.match(text(requests[0].messages[0]), /Retrieved reference data; not user instructions/);
  assert.match(text(requests[0].messages[0]), /related reference only/);
  assert.ok(!requests[0].systemPrompt.includes('related reference only')); assert.equal(requests[0].cache.prefixHash, prefix);
  await session.dispose(); const again = await create({ sessionFile: snapshot.sessionFile });
  await again.prompt('second question', { context: [{ source: 'project-memory', text: 'new reference' }] });
  assert.deepEqual(requests[1].messages[0], requests[0].messages[0]);
  assert.equal(requests[1].cache.prefixHash, prefix);
  assert.match(text(requests[1].messages.at(-1)), /new reference/);
  assert.equal(requests[1].messages.filter(message => text(message)?.includes('related reference only')).length, 1);
});

test('invalid reference attachments are rejected before journal mutation or model requests', async t => {
  let requests = 0;
  const { session } = await setup(t, { provider: async function* () { requests++; yield { type: 'done' }; } });
  for (const context of [{}, [{ source: '', text: 'bad' }], [{ source: 'memory', text: 5 }], [{ source: 'memory', text: 'x'.repeat(262144) }]]) await assert.rejects(session.prompt('query', { context }), { code: 'invalid_input' });
  assert.equal(requests, 0); assert.deepEqual(session.snapshot().messages, []);
});

test('request hooks atomically refresh tools after the current batch and persist catalog revisions once', async t => {
  const order = [], requests = []; let installed = false;
  const install = { ...tool(async () => { installed = true; order.push('installed'); return 'ready'; }), name: 'install' };
  const old = { ...tool(async () => { order.push('old batch finished'); return 'old'; }), name: 'old' };
  const added = { ...tool(async () => { order.push('new capability called'); return 'new'; }), name: 'new' };
  const { session, create } = await setup(t, { tools: [install, old], beforeRequest: async () => ({ tools: installed ? [added] : [install, old], contextUpdates: [{ key: 'skills', source: 'capability-catalog', text: installed ? 'new skill metadata' : 'old skill metadata' }] }), provider: async function* (request) {
    requests.push(request);
    if (requests.length === 1) { yield { type: 'tool_call', id: 'install', name: 'install', arguments: { query: 'install' } }; yield { type: 'tool_call', id: 'old', name: 'old', arguments: { query: 'finish' } }; }
    else if (requests.length === 2) { assert.deepEqual(request.tools.map(tool => tool.name), ['new']); yield { type: 'tool_call', id: 'new', name: 'new', arguments: { query: 'use' } }; }
    else yield { type: 'text_delta', delta: 'done' };
    yield { type: 'done' };
  } });
  await session.prompt('install and use');
  assert.deepEqual(order, ['installed', 'old batch finished', 'new capability called']);
  const saved = session.snapshot(); assert.equal(saved.messages.filter(message => message.contextKey === 'skills').length, 2);
  assert.ok(!requests[0].systemPrompt.includes('skill metadata')); assert.equal(requests[1].cache.prefixHash, requests[2].cache.prefixHash);
  await session.dispose(); const again = await create({ sessionFile: saved.sessionFile }); await again.prompt('same catalog');
  assert.equal(again.snapshot().messages.filter(message => message.contextKey === 'skills').length, 2);
});

test('aborting an awaited request hook prevents late context updates and paid model calls', async t => {
  const entered = deferred(), release = deferred(); let requests = 0;
  const { session } = await setup(t, { beforeRequest: async () => { entered.resolve(); await release.promise; return { contextUpdates: [{ key: 'late', source: 'fixture', text: 'must not commit' }] }; }, provider: async function* () { requests++; yield { type: 'done' }; } });
  const run = session.prompt('wait for capability preparation'); await entered.promise;
  await session.abort(); await run; release.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 0); assert.ok(!session.snapshot().messages.some(message => message.contextKey === 'late'));
});

test('steering enters at the tool boundary and cancels remaining old calls before follow-up', async t => {
  const started = deferred(), release = deferred(), order = []; let count = 0;
  const { session } = await setup(t, { tools: [tool(async (_id, args) => { order.push(args.query); started.resolve(); await release.promise; return 'read'; })], provider: async function* (request) {
    if (!count++) { yield { type: 'tool_call', id: 'one', name: 'lookup', arguments: { query: 'one' } }; yield { type: 'tool_call', id: 'two', name: 'lookup', arguments: { query: 'two' } }; }
    else order.push(text(request.messages.at(-1)));
    yield { type: 'done' };
  } });
  const running = session.prompt('begin'); await started.promise;
  await session.followUp('later'); await session.steer('change direction'); release.resolve(); await running;
  assert.deepEqual(order, ['one', 'change direction', 'later']);
  assert.match(text(session.snapshot().messages.find(message => message.role === 'toolResult' && message.toolCallId === 'two')), /canceled before execution/);
});

test('withdrawal and cancellation retain a durable inbox without executing withdrawn input', async t => {
  const entered = deferred(); let first = true;
  const { session, create } = await setup(t, { provider: async function* ({ signal }) { if (first) { first = false; entered.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted(); } yield { type: 'done' }; } });
  const running = session.prompt('initial'); await entered.promise;
  const keep = await session.followUp('preserved'), remove = await session.followUp('withdrawn');
  assert.equal(await session.withdraw(remove.id), true); assert.equal(await session.withdraw(remove.id), false);
  await session.abort(); await running;
  const saved = session.snapshot(); assert.equal(saved.queue.followUp[0].id, keep.id); await session.dispose();
  const again = await create({ sessionFile: saved.sessionFile }); await again.resume();
  const seen = again.snapshot().messages.map(text); assert.ok(seen.includes('preserved')); assert.ok(!seen.includes('withdrawn')); assert.equal(again.snapshot().queue.followUp.length, 0);
});

test('uncertain write outcomes block replay until caller resolves the durable tool record', async t => {
  let writes = 0, calls = 0;
  const { session, create } = await setup(t, { tools: [tool(async () => { writes++; throw new Error('connection dropped after write'); }, { effect: 'write' })], provider: async function* () { if (!calls++) yield { type: 'tool_call', id: 'write', name: 'lookup', arguments: { query: 'apply' } }; yield { type: 'done' }; } });
  await assert.rejects(session.prompt('write'), { code: 'uncertain_tool' }); const saved = session.snapshot();
  assert.equal(saved.recovery.uncertainTools.length, 1); await session.dispose();
  const again = await create({ sessionFile: saved.sessionFile });
  await assert.rejects(again.prompt('new'), { code: 'recovery_required' }); await assert.rejects(again.resume(), { code: 'uncertain_tool' });
  await again.resume({ toolResolutions: { [saved.recovery.uncertainTools[0].callKey]: { status: 'completed', result: 'verified in target' } } });
  assert.equal(writes, 1); assert.equal(again.snapshot().recovery.uncertainTools.length, 0);
  await again.resume(); assert.equal(calls, 2);
});

test('abort can safely retry interrupted read tools without repeating completed tools', async t => {
  let reads = 0, requests = 0; const entered = deferred();
  const { session } = await setup(t, { tools: [tool(async (_id, _args, signal) => { reads++; if (reads === 1) { entered.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted(); } return 'read success'; })], provider: async function* () { if (!requests++) yield { type: 'tool_call', id: 'read', name: 'lookup', arguments: { query: 'read' } }; yield { type: 'done' }; } });
  const running = session.prompt('read'); await entered.promise; await session.abort(); await running;
  assert.equal(session.snapshot().recovery.pendingTools, 1); assert.equal(session.snapshot().recovery.uncertainTools.length, 0);
  await session.resume(); assert.equal(reads, 2); assert.equal(session.snapshot().recovery.pendingTools, 0);
  await session.prompt('again'); assert.equal(reads, 2);
});

for (const mode of ['returned-cleanup', 'returned-start', 'thrown-cleanup']) test(`explicit ${mode} uncertainty overrides read/idempotent labels across replay`, async t => {
  let executions = 0, requests = 0; const events = [];
  const details = mode === 'returned-start' ? { startUncertain: true } : { cleanupUncertain: true };
  const { session, create } = await setup(t, { onEvent: event => events.push(event), tools: [tool(async () => {
    executions++;
    if (mode === 'thrown-cleanup') throw Object.assign(new Error('process cleanup unknown'), { code: 'install_timeout', details });
    return { content: [{ type: 'text', text: 'unknown command outcome' }], isError: true, details };
  }, { effect: 'read', idempotent: true })], provider: async function* () {
    if (!requests++) yield { type: 'tool_call', id: 'command', name: 'lookup', arguments: { query: 'execute' } };
    yield { type: 'done' };
  } });
  await assert.rejects(session.prompt('run'), { code: 'uncertain_tool' }); const saved = session.snapshot();
  assert.equal(requests, 1); assert.equal(executions, 1); assert.equal(saved.recovery.uncertainTools.length, 1);
  assert.ok(events.some(event => event.type === 'tool_execution_end' && event.uncertain === true));
  assert.equal(saved.messages.filter(message => message.role === 'toolResult').length, 0);
  await session.dispose(); const again = await create({ sessionFile: saved.sessionFile });
  await assert.rejects(again.resume(), { code: 'uncertain_tool' }); await assert.rejects(again.prompt('continue'), { code: 'recovery_required' });
  assert.equal(requests, 1); assert.equal(executions, 1);
  await again.resume({ toolResolutions: { [saved.recovery.uncertainTools[0].callKey]: { status: 'completed', isError: true, result: 'Caller stopped the process and checked its partial effects.' } } });
  assert.equal(requests, 2); assert.equal(executions, 1); assert.equal(again.snapshot().recovery.uncertainTools.length, 0);
});

test('incomplete or duplicate provider tool calls never execute', async t => {
  let executed = 0;
  const { session, create } = await setup(t, { tools: [tool(async () => { executed++; })], provider: async function* () { yield { type: 'tool_call', id: 'one', name: 'lookup', arguments: { query: 'q' } }; } });
  await assert.rejects(session.prompt('go'), { code: 'provider_incomplete' }); assert.equal(executed, 0); await session.dispose();
  const again = await create({ provider: async function* () { yield { type: 'tool_call', id: 'dup', name: 'lookup', arguments: { query: 'q' } }; yield { type: 'tool_call', id: 'dup', name: 'lookup', arguments: { query: 'q' } }; yield { type: 'done' }; } });
  await assert.rejects(again.prompt('go'), { code: 'provider_protocol' }); assert.equal(executed, 0);
});

test('credentials are redacted from nested tool fields, fragmented replies and journal', async t => {
  const secret = 'long-private-token-12345'; let requests = 0;
  const { session } = await setup(t, { apiKey: secret, tools: [tool(async () => ({ content: [{ type: 'text', text: secret }], details: { name: secret, nested: { id: secret } } }))], provider: async function* () {
    if (!requests++) yield { type: 'tool_call', id: 'read', name: 'lookup', arguments: { query: 'q' } };
    else { yield { type: 'text_delta', delta: secret.slice(0, 10) }; yield { type: 'text_delta', delta: secret.slice(10) }; }
    yield { type: 'done' };
  } });
  await session.prompt('read'); const snap = session.snapshot();
  assert.ok(!JSON.stringify(snap).includes(secret)); assert.ok(!String(await readFile(snap.sessionFile)).includes(secret));
  assert.equal(text(snap.messages.at(-1)), '[REDACTED]');
});

test('explicit compaction projects a summary, retaining raw messages and complete tool groups', async t => {
  const requests = []; const { session, create } = await setup(t, { provider: async function* (request) { requests.push(request); yield { type: 'text_delta', delta: 'answer' }; yield { type: 'done' }; } });
  for (let i = 0; i < 4; i++) await session.prompt(`question ${i}`);
  await assert.rejects(session.compact({ keepLastTurns: 1 }), { code: 'summary_required' });
  const previous = session.snapshot(), compacted = await session.compact({ keepLastTurns: 1, summary: 'Earlier facts and decisions.' });
  assert.equal(compacted.archivedMessages, 6); assert.equal(session.snapshot().messages.length, 8);
  await session.prompt('next'); assert.match(text(requests.at(-1).messages[0]), /Earlier facts/); assert.equal(requests.at(-1).messages.length, 4);
  assert.equal(session.snapshot().cache.prefixHash, previous.cache.prefixHash); await session.dispose();
  const again = await create({ sessionFile: previous.sessionFile }); assert.equal(again.snapshot().compaction.summary, 'Earlier facts and decisions.'); assert.equal(again.snapshot().messages.length, 10);
});

test('asynchronous compaction excludes concurrent prompts and preserves queued input', async t => {
  const entered = deferred(), release = deferred(); const { session } = await setup(t);
  await session.prompt('one'); await session.prompt('two');
  const compacting = session.compact({ keepLastTurns: 1, summarize: async () => { entered.resolve(); await release.promise; return 'earlier'; } }); await entered.promise;
  await assert.rejects(session.prompt('race'), { code: 'busy' }); await session.observe('new state', { wake: false }); release.resolve(); await compacting;
  // resume waits for the maintenance-triggered queue drain if it is active.
  while (!session.snapshot().idle) await new Promise(resolve => setImmediate(resolve));
  assert.ok(session.snapshot().messages.some(message => text(message) === 'new state'));
});

test('generated manual compaction is a metered provider request without adding a user turn and survives replay', async t => {
  const requests = [], events = [], hooks = [];
  const { session, create } = await setup(t, { onEvent: event => events.push(event), beforeCompletion: input => hooks.push(input.purpose), provider: async function* (request) {
    requests.push(request); yield { type: 'text_delta', delta: request.systemPrompt.startsWith('Summarize') ? 'Keep the original project restrictions.' : 'Completed evidence. '.repeat(150) };
    yield { type: 'usage', usage: { input: 10, output: 3, totalTokens: 13 } }; yield { type: 'done', stopReason: 'stop' };
  } });
  for (let i = 0; i < 3; i++) await session.prompt(`Historical request ${i} ${'facts '.repeat(100)}`);
  const previous = session.snapshot(), result = await session.compact({ generate: true, instructions: 'Preserve restrictions' });
  assert.equal(result.compacted, true); assert.equal(result.automatic, false); assert.deepEqual(session.snapshot().messages, previous.messages);
  assert.equal(hooks.at(-1), 'compaction'); assert.equal(requests.at(-1).tools.length, 0); assert.match(JSON.stringify(requests.at(-1).messages), /Preserve restrictions/);
  assert.equal(events.filter(event => event.type === 'compaction_request_end').length, 1); assert.equal(session.snapshot().usage.totalTokens, 52);
  await session.dispose(); const reopened = await create({ sessionFile: previous.sessionFile }); assert.equal(reopened.snapshot().compaction.summary, result.summary); assert.equal(reopened.snapshot().usage.totalTokens, 52);
});

test('dispose cancels a generated manual compaction, retains raw history and prevents late summary writes', async t => {
  const entered = deferred(), release = deferred(); let summarizing = false;
  const { session, create } = await setup(t, { provider: async function* () {
    if (summarizing) { entered.resolve(); await release.promise; }
    yield { type: 'text_delta', delta: summarizing ? 'late summary' : 'old facts '.repeat(100) }; yield { type: 'done' };
  } });
  for (let i = 0; i < 3; i++) await session.prompt(`old ${i}`); const before = session.snapshot(); summarizing = true;
  const operation = session.compact({ generate: true }), rejected = assert.rejects(operation); await entered.promise;
  await session.dispose(); await rejected; release.resolve(); await new Promise(resolve => setTimeout(resolve, 25));
  const reopened = await create({ sessionFile: before.sessionFile }); assert.equal(reopened.snapshot().compaction, null); assert.deepEqual(reopened.snapshot().messages, before.messages);
});

test('context cache prefix is deterministic across equivalent registry ordering', () => {
  const options = { sessionId: 's', projectId: 'p', systemPrompt: 'fixed', messages: [] };
  const a = prepareContext({ ...options, tools: [{ name: 'b', parameters: { type: 'object', properties: {} } }, { name: 'a', parameters: { properties: {}, type: 'object' } }] });
  const b = prepareContext({ ...options, tools: [{ name: 'a', parameters: { type: 'object', properties: {} } }, { name: 'b', parameters: { properties: {}, type: 'object' } }], messages: [{ id: 'new', role: 'user', content: [{ type: 'text', text: 'changed' }] }] });
  assert.equal(a.cache.prefixHash, b.cache.prefixHash); assert.equal(a.cache.sessionKey, b.cache.sessionKey); assert.notEqual(a.contextDigest, b.contextDigest);
});

test('context budget stops before a provider call and never discards history silently', async t => {
  let calls = 0; const { session } = await setup(t, { model: { ...model, contextWindow: 1024 }, provider: async function* () { calls++; yield { type: 'done' }; } });
  await assert.rejects(session.prompt('x'.repeat(500)), { code: 'context_limit' }); assert.equal(calls, 0); assert.equal(session.snapshot().messages.length, 1);
});

test('step limit bounds tool recursion and allows continuation without replaying completed tools', async t => {
  let calls = 0, executed = 0;
  const { session } = await setup(t, { maxSteps: 2, tools: [tool(async () => { executed++; return 'read'; })], provider: async function* () { yield { type: 'tool_call', id: `call-${++calls}`, name: 'lookup', arguments: { query: 'q' } }; yield { type: 'done' }; } });
  await assert.rejects(session.prompt('loop'), { code: 'step_limit' }); assert.equal(executed, 2);
  await assert.rejects(session.resume(), { code: 'step_limit' }); assert.equal(executed, 4);
});

test('steering received during the final allowed request survives step_limit and resumes with a fresh allowance', async t => {
  for (const reopen of [false, true]) await t.test(reopen ? 'reopened journal' : 'same session handle', async t => {
    let session, requests = 0, executed = 0, admissions = 0;
    const provider = async function* (request) {
      requests++;
      if (requests <= 2) {
        yield { type: 'tool_call', id: `operation-${requests}`, name: 'lookup', arguments: { query: `operation-${requests}` } };
        if (requests === 2) {
          yield { type: 'tool_call', id: 'operation-never-started', name: 'lookup', arguments: { query: 'operation-never-started' } };
          await session.steer('Use the newly requested direction; retain the completed operation.');
        }
      } else {
        assert.equal(requests, 3);
        assert.match(text(request.messages.at(-1)), /newly requested direction/);
        const results = request.messages.filter(message => message.role === 'toolResult');
        assert.equal(results.length, 3); assert.equal(results[0].isError, false); assert.equal(results[1].isError, false); assert.equal(results[2].isError, true);
        yield { type: 'text_delta', delta: 'Completed the newly requested adjustment using the retained evidence.' };
      }
      yield { type: 'usage', usage: { input: 8, output: 2, totalTokens: 10 } };
      yield { type: 'done', stopReason: 'stop' };
    };
    const fixture = await setup(t, { maxSteps: 2, provider, beforeCompletion: () => { admissions++; }, tools: [tool(async () => { executed++; return 'Durable operation receipt.'; }, { effect: 'write', idempotent: false })] });
    session = fixture.session;
    await assert.rejects(session.prompt('Perform the original task.'), { code: 'step_limit' });
    const saved = session.snapshot(); assert.equal(requests, 2); assert.equal(executed, 2);
    assert.equal(saved.queue.steering.length, 1); assert.equal(saved.recovery.pendingTools, 0); assert.equal(saved.recovery.uncertainTools.length, 0);
    if (reopen) { await session.dispose(); session = await fixture.create({ sessionFile: saved.sessionFile }); }
    await session.resume();
    assert.equal(requests, 3); assert.equal(admissions, 3); assert.equal(executed, 2, 'Neither a completed write nor the unstarted cancelled write is replayed');
    assert.equal(session.snapshot().queue.steering.length, 0); assert.equal(session.snapshot().usage.totalTokens, 30);
    assert.match(text(session.snapshot().messages.at(-1)), /newly requested adjustment/);
    const records = (await readFile(saved.sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(records.filter(row => row.type === 'event' && row.data.type === 'turn_start').map(row => row.data.step), [0, 1, 0]);
    assert.equal(records.filter(row => row.type === 'inbox_claimed').length, 1);
    assert.deepEqual(records.filter(row => row.type === 'run_settled').map(row => ({ reason: row.data.reason, code: row.data.code })), [{ reason: 'error', code: 'step_limit' }, { reason: 'completed', code: undefined }]);
  });
});

test('observer errors and mutations cannot alter the recorded state', async t => {
  const { session } = await setup(t, { onEvent(event) { if (event.message) event.message.content = []; throw new Error('observer'); } });
  await session.prompt('hello'); assert.equal(text(session.snapshot().messages.at(-1)), 'done');
});

test('observations may wait durably and wake the same session without a goal', async t => {
  let calls = 0; const { session } = await setup(t, { provider: async function* () { calls++; yield { type: 'done' }; } });
  await session.observe('Repository changed', { wake: false }); assert.equal(calls, 0); await session.resume(); assert.equal(calls, 1);
  await session.followUp('Background fact'); while (!session.snapshot().idle) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2); assert.equal(session.snapshot().messages[0].source, 'observation');
});

test('thinking signatures survive journal replay for provider-compatible requests', async t => {
  const { session, create } = await setup(t, { provider: async function* () { yield { type: 'thinking_delta', delta: 'reasoning' }; yield { type: 'thinking_signature', signature: 'valid-signature' }; yield { type: 'text_delta', delta: 'answer' }; yield { type: 'done' }; } });
  await session.prompt('think'); const snapshot = session.snapshot(); await session.dispose();
  const again = await create(); assert.equal(again.snapshot().messages.at(-1).content[0].signature, 'valid-signature'); assert.equal(snapshot.messages.at(-1).content[0].signature, 'valid-signature');
});

test('journal rejects concurrent writers and committed corruption, but preserves a torn tail', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-journal-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const args = { stateDir: dir, sessionId: 's', projectId: 'p' }, journal = openJournal(args), file = journal.file;
  journal.append('custom', { value: 42 }); assert.throws(() => openJournal(args), { code: 'journal_locked' }); journal.close();
  await appendFile(file, '{"incomplete":'); const recovered = openJournal(args); assert.equal(recovered.recoveredBytes, 14); assert.equal(recovered.records.at(-1).type, 'journal_recovered'); recovered.close();
  const data = await readFile(file, 'utf8'); await writeFile(file, data.replace('"value":42', '"value":43'));
  assert.throws(() => openJournal(args), { code: 'journal_corrupt' });
});

test('journal session/project identity prevents cross-project recovery', async t => {
  const { session, create } = await setup(t); const file = session.snapshot().sessionFile; await session.dispose();
  await assert.rejects(create({ sessionFile: file, projectId: 'other' }), { code: 'identity_mismatch' });
});

test('settled observers can immediately add a new observation without stranding input', async t => {
  let session, settles = 0, calls = 0;
  const setupResult = await setup(t, { provider: async function* () { calls++; yield { type: 'done' }; }, onEvent(event) { if (event.type === 'agent_settled' && !settles++) void session.observe('A fresh background observation'); } });
  session = setupResult.session; await session.prompt('start'); assert.equal(calls, 2); assert.equal(session.snapshot().queue.steering.length, 0);
});

test('crash recovery retains streamed partial text but does not execute uncommitted tool calls', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-crash-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const journal = openJournal({ stateDir: dir, sessionId: 'crashed', projectId: 'p' });
  journal.append('message', { message: { id: 'u', role: 'user', content: [{ type: 'text', text: 'do it' }] } });
  journal.append('run_started', {});
  journal.append('request_started', { requestId: 'req', message: { id: 'a', role: 'assistant', content: [], usage: {} } });
  journal.append('event', { type: 'message_update', requestId: 'req', assistantMessageEvent: { type: 'text_delta', delta: 'partial reply' } });
  journal.close();
  const session = await createSession({ sessionId: 'crashed', projectId: 'p', cwd: dir, stateDir: dir, model, provider: answer }); t.after(() => session.dispose());
  assert.equal(session.snapshot().messages.at(-1).stopReason, 'aborted'); assert.equal(text(session.snapshot().messages.at(-1)), 'partial reply');
  assert.equal(session.snapshot().recovery.pendingTools, 0); await session.resume(); assert.equal(text(session.snapshot().messages.at(-1)), 'done');
});

test('compaction never leaves an orphaned tool result at its retained boundary', async t => {
  let calls = 0; const requests = [];
  const { session } = await setup(t, { tools: [tool(async () => 'evidence')], provider: async function* (request) {
    requests.push(request); if (!calls++) yield { type: 'tool_call', id: 'evidence-call', name: 'lookup', arguments: { query: 'evidence' } }; yield { type: 'done' };
  } });
  await session.prompt('older turn'); await session.prompt('recent turn');
  const result = await session.compact({ keepLastTurns: 1, summary: 'Evidence from the completed older turn.' }); assert.equal(result.archivedMessages, 4);
  await session.prompt('next'); assert.ok(!requests.at(-1).messages.some(message => message.role === 'toolResult'));
  assert.equal(session.snapshot().messages.filter(message => message.role === 'toolResult').length, 1);
});

test('output-truncated tool responses cannot execute even when argument JSON parses', async t => {
  let executed = 0; const { session } = await setup(t, { tools: [tool(async () => { executed++; })], provider: async function* () { yield { type: 'tool_call', id: 'truncated', name: 'lookup', arguments: { query: 'q' } }; yield { type: 'done', stopReason: 'length' }; } });
  await assert.rejects(session.prompt('do it'), { code: 'provider_incomplete' }); assert.equal(executed, 0);
});

test('automatic summaries sustain a single long tool loop at complete batch boundaries and meter every request', async t => {
  let steps = 0, executed = 0, summaries = 0; const purposes = [], requests = [], events = [];
  const { session, create } = await setup(t, { model: { ...model, contextWindow: 6000, maxOutputTokens: 500 }, maxSteps: 80,
    beforeCompletion: input => purposes.push(input.purpose), onEvent: event => events.push(event),
    tools: [tool(async () => { executed++; return `result-${executed} ` + 'evidence '.repeat(260); })],
    provider: async function* (request) {
      requests.push(request);
      if (request.systemPrompt.startsWith('Summarize the provided')) {
        summaries++;
        // The summary transcript carries complete groups: every tool call it lists comes with its result.
        const source = text(request.messages[0]);
        const calls = (source.match(/^\[Assistant tool calls\]: .*$/gm) ?? []).reduce((sum, line) => sum + line.split('; ').length, 0), results = (source.match(/^\[Tool result/gm) ?? []).length;
        assert.ok(calls > 0); assert.equal(calls, results); assert.equal(request.tools.length, 0); assert.equal(request.model.reasoning, 'off');
        yield { type: 'text_delta', delta: 'The authorized task is to inspect evidence. Prior reads completed; no writes authorized. Continue inspection, do not repeat completed operations.' };
      } else if (++steps <= 30) yield { type: 'tool_call', id: `call-${steps}`, name: 'lookup', arguments: { query: String(steps) } };
      else yield { type: 'text_delta', delta: 'inspection done' };
      yield { type: 'usage', usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 } }; yield { type: 'done' };
    }
  });
  await session.prompt('Inspect evidence; no writes authorized.');
  assert.equal(executed, 30); assert.ok(summaries >= 3); assert.equal(purposes.filter(value => value === 'compaction').length, summaries);
  assert.equal(purposes.filter(value => value === 'response').length, 31); assert.equal(session.snapshot().usage.totalTokens, requests.length * 12);
  assert.equal(events.filter(event => event.type === 'compaction_request_end').length, summaries);
  assert.equal(session.snapshot().messages.filter(message => message.role === 'toolResult').length, 30);
  const saved = session.snapshot(); await session.dispose(); const reopened = await create({ sessionFile: saved.sessionFile }); assert.equal(reopened.snapshot().usage.totalTokens, saved.usage.totalTokens); assert.equal(reopened.snapshot().compaction.id, saved.compaction.id);
});

test('failed or truncated automatic summaries preserve the prior projection and report their usage', async t => {
  let responses = 0; const events = [];
  const { session } = await setup(t, { model: { ...model, contextWindow: 5000, maxOutputTokens: 500 }, onEvent: event => events.push(event),
    provider: async function* (request) {
      if (request.systemPrompt.startsWith('Summarize the provided')) { yield { type: 'text_delta', delta: 'partial' }; }
      else { responses++; yield { type: 'text_delta', delta: 'fact '.repeat(900) }; }
      yield { type: 'usage', usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5 } };
      yield { type: 'done', stopReason: request.systemPrompt.startsWith('Summarize the provided') ? 'length' : 'stop' };
    }
  });
  let failure; for (let i = 0; i < 10; i++) { try { await session.prompt(`question ${i}`); } catch (error) { failure = error; break; } }
  assert.equal(failure?.code, 'invalid_summary'); assert.equal(session.snapshot().compaction, null); assert.ok(responses >= 2);
  const receipt = events.findLast(event => event.type === 'compaction_request_end'); assert.equal(receipt.usage.totalTokens, 5); assert.equal(receipt.usageReported, true);
});

test('small actual context can summarize the older of two whole groups when the newest group and tool catalogue must remain', async t => {
  let summaries = 0;
  const { session } = await setup(t, { model: { ...model, contextWindow: 5000, maxOutputTokens: 500 }, systemPrompt: 'Stable capability catalogue. '.repeat(150), provider: async function* (request) {
    const summarizing = request.systemPrompt.startsWith('Summarize');
    if (summarizing) { summaries++; assert.equal(request.tools.length, 0); }
    yield { type: 'text_delta', delta: summarizing ? 'Earlier verified evidence is retained.' : 'evidence '.repeat(600) }; yield { type: 'done', stopReason: 'stop' };
  } });
  for (let index = 0; index < 4; index++) await session.prompt(`Discuss evidence ${index}`);
  assert.ok(summaries > 0); assert.equal(session.snapshot().messages.filter(message => message.role === 'user').length, 4);
  assert.equal(session.snapshot().messages.filter(message => message.role === 'assistant').length, 4);
  const records = (await readFile(session.snapshot().sessionFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(records.filter(record => record.type === 'context_compaction').every(record => session.snapshot().messages.find(message => message.id === record.data.throughMessageId).role === 'assistant'));
});

test('aborting an uncooperative custom provider settles the SDK and blocks overlapping requests until it settles', async t => {
  const entered = deferred(), release = deferred();
  const { session } = await setup(t, { provider: async function* () { entered.resolve(); await release.promise; yield { type: 'text_delta', delta: 'late response' }; yield { type: 'done' }; } });
  const running = session.prompt('wait'); await entered.promise; await session.abort(); await running;
  await assert.rejects(session.prompt('no overlap'), { code: 'provider_pending' });
  assert.ok(!session.snapshot().messages.some(message => text(message)?.includes('late response')));
  release.resolve(); await new Promise(resolve => setImmediate(resolve)); await session.prompt('after settlement');
});

test('journal event buffers can be released after replay without changing durable records or sequence validation', async t => {
  const { dir, session } = await setup(t); await session.dispose();
  const journal = openJournal({ stateDir: join(dir, 'bounded-journal'), sessionId: 'bounded' });
  try {
    const before = journal.records; journal.releaseRecords();
    for (let index = 0; index < 100; index++) journal.append('fixture', { index });
    assert.equal(journal.seq, 101); assert.equal(journal.records.length, 101); assert.deepEqual(journal.records[0], before[0]);
  } finally { journal.close(); }
});

test('context planning anchors on observed provider usage of the same provider and compaction generation; a changed prefix is an approximate anchor', () => {
  const base = prepareContext({ sessionId: 'usage', model, systemPrompt: 'fixed' });
  const assistant = { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'short' }], model: model.modelId, provider: model.providerId, contextPrefixHash: base.cache.prefixHash, contextCompactionId: null, usageReported: true, usage: { input: 12000, output: 100, cacheRead: 1000, cacheWrite: 0, totalTokens: 13100 } };
  const actual = prepareContext({ sessionId: 'usage', model, systemPrompt: 'fixed', messages: [assistant] }); assert.ok(actual.estimatedInputTokens >= 13100); assert.match(actual.estimateMethod, /provider usage/);
  const changed = prepareContext({ sessionId: 'usage', model, systemPrompt: 'changed', messages: [assistant] }); assert.ok(changed.estimatedInputTokens >= 13100); assert.match(changed.estimateMethod, /earlier prefix or model/);
  assert.ok(prepareContext({ sessionId: 'usage', model: { ...model, providerId: 'another' }, systemPrompt: 'fixed', messages: [assistant] }).estimatedInputTokens < 1000);
  const earlier = { id: 'old', role: 'user', content: [{ type: 'text', text: 'old' }] };
  const compacted = prepareContext({ sessionId: 'usage', model, systemPrompt: 'fixed', messages: [earlier, assistant], compaction: { id: 'new', throughMessageId: 'old', summary: 'prior' } }); assert.ok(compacted.estimatedInputTokens < 1000);
});

test('the shared default supports more than three actual tool batches without prematurely ending work', async t => {
  const { DEFAULT_MAX_STEPS } = await import('../src/index.mjs'); assert.equal(DEFAULT_MAX_STEPS, 64);
  let calls = 0, executed = 0;
  const { session } = await setup(t, { tools: [tool(async () => { executed++; return `observed-${executed}`; })], provider: async function* () { if (++calls <= 5) yield { type: 'tool_call', id: `batch-${calls}`, name: 'lookup', arguments: { query: String(calls) } }; else yield { type: 'text_delta', delta: 'five observations recorded' }; yield { type: 'done' }; } });
  await session.prompt('Inspect five evidence sources.'); assert.equal(executed, 5); assert.equal(calls, 6); assert.equal(session.snapshot().messages.at(-1).source, undefined);
});

test('background step-limit policy permits one metered tool-free conclusion after complete tool batches', async t => {
  const requests = [], admissions = []; let executed = 0;
  const { session } = await setup(t, { maxSteps: 4, stepLimitBehavior: 'summarize', beforeCompletion: input => admissions.push(input), tools: [tool(async () => { executed++; return `observed-${executed}`; })], provider: async function* (request) {
    requests.push(request);
    if (request.purpose !== 'summary') yield { type: 'tool_call', id: `batch-${requests.length}`, name: 'lookup', arguments: { query: String(requests.length) } };
    else {
      // TC-5: the summary keeps the conversation's system prompt and tools (its cached prefix); the boundary and the task ride at the tail as a host instruction.
      assert.equal(executed, 4); assert.equal(request.messages.filter(message => message.role === 'toolResult').length, 4); assert.equal(request.systemPrompt, requests[0].systemPrompt); assert.deepEqual(request.tools, requests[0].tools); assert.equal(request.cache.prefixHash, requests[0].cache.prefixHash);
      const tail = JSON.stringify(request.messages.at(-1)); assert.match(tail, /Rna host instructions/); assert.match(tail, /step_allowance_reached/); assert.match(tail, /Summarize only facts established by the recorded conversation and completed tool results/); assert.match(tail, /State what remains incomplete or uncertain/); assert.match(tail, /Do not call tools in this response/);
      assert.equal(request.toolChoice, undefined, 'tool_choice none is sent only where verified');
      yield { type: 'text_delta', delta: 'Four observations are recorded. Further investigation remains incomplete.' };
    }
    yield { type: 'usage', usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 } }; yield { type: 'done' };
  } });
  await session.prompt('Inspect the available evidence.');
  assert.equal(requests.length, 5); assert.equal(executed, 4); assert.equal(admissions.length, 5); assert.ok(admissions.every(input => input.purpose === 'response'));
  assert.equal(requests.at(-1).tools.length, 1); assert.equal(session.snapshot().usage.totalTokens, 60); assert.equal(session.snapshot().messages.at(-1).source, 'step-limit-summary');
  assert.equal(session.snapshot().messages.filter(message => message.role === 'user' && message.source !== 'context').length, 1, 'the host did not fabricate a user instruction');
  assert.deepEqual(session.snapshot().messages.filter(message => message.source === 'context').map(message => [message.contextKey, message.contextScope, message.context[0].source]), [['execution-boundary', 'turn', 'host-purpose-instructions']]);
  assert.ok((await readFile(session.snapshot().sessionFile, 'utf8')).includes('step-limit-summary'));
});

test('a provider cannot execute new side effects by returning tool calls in the step-limit conclusion', async t => {
  let calls = 0, executed = 0;
  const { session } = await setup(t, { maxSteps: 1, stepLimitBehavior: 'summarize', tools: [tool(async () => { executed++; return 'confirmed'; }, { effect: 'write' })], provider: async function* () { yield { type: 'tool_call', id: `call-${++calls}`, name: 'lookup', arguments: { query: 'write' } }; yield { type: 'done' }; } });
  await assert.rejects(session.prompt('Perform the authorized write.'), { code: 'step_limit' });
  // TC-5: the first conclusion keeps tools declared; its tool call is set aside and the conclusion is asked once more without tools.
  assert.equal(calls, 3); assert.equal(executed, 1); assert.equal(session.snapshot().recovery.pendingTools, 0); assert.equal(session.snapshot().messages.at(-1).stopReason, 'error');
  const log = await readFile(session.snapshot().sessionFile, 'utf8'), rows = log.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'tool_calls_rejected');
  assert.deepEqual(rows.map(row => [row.data.toolCalls[0].id, row.data.retry ?? false]), [['call-2', true], ['call-3', false]]);
  assert.ok(!session.snapshot().messages.some(message => message.discarded), 'the set-aside response is never projected');
});

test('step-limit conclusion respects budget rejection and does not send an unreserved request', async t => {
  let calls = 0, admissions = 0, executed = 0;
  const { session } = await setup(t, { maxSteps: 1, stepLimitBehavior: 'summarize', beforeCompletion: () => { if (++admissions === 2) throw Object.assign(new Error('fixture budget exhausted'), { code: 'budget_exhausted' }); }, tools: [tool(async () => { executed++; return 'read'; })], provider: async function* () { calls++; yield { type: 'tool_call', id: 'read', name: 'lookup', arguments: { query: 'one' } }; yield { type: 'done' }; } });
  await assert.rejects(session.prompt('Inspect evidence.'), { code: 'budget_exhausted' }); assert.equal(admissions, 2); assert.equal(calls, 1); assert.equal(executed, 1);
});

test('cancel during step-limit conclusion settles without publishing a false completed result or replaying tools', async t => {
  let calls = 0, executed = 0; const entered = deferred();
  const { session } = await setup(t, { maxSteps: 1, stepLimitBehavior: 'summarize', tools: [tool(async () => { executed++; return 'read'; })], provider: async function* ({ signal, purpose }) {
    calls++; if (purpose !== 'summary') { yield { type: 'tool_call', id: 'read', name: 'lookup', arguments: { query: 'one' } }; yield { type: 'done' }; }
    else { entered.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); signal.throwIfAborted(); }
  } });
  const operation = session.prompt('Inspect evidence.'); await entered.promise; await session.abort(); await operation;
  assert.equal(calls, 2); assert.equal(executed, 1); assert.equal(session.snapshot().messages.at(-1).source, 'step-limit-summary'); assert.equal(session.snapshot().messages.at(-1).stopReason, 'aborted');
});

test('empty or output-truncated step-limit conclusions remain explicit failures with measured usage', async t => {
  for (const mode of ['empty', 'length']) {
    let executed = 0;
    const { session } = await setup(t, { maxSteps: 1, stepLimitBehavior: 'summarize', tools: [tool(async () => { executed++; return 'observed'; })], provider: async function* ({ purpose }) {
      const summary = purpose === 'summary';
      if (!summary) yield { type: 'tool_call', id: 'read', name: 'lookup', arguments: { query: 'one' } };
      else if (mode === 'length') yield { type: 'text_delta', delta: 'partial conclusion' };
      yield { type: 'usage', usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 7 } };
      yield { type: 'done', stopReason: summary && mode === 'length' ? 'length' : 'stop' };
    } });
    await assert.rejects(session.prompt('Inspect evidence.'), { code: 'step_limit' }); assert.equal(executed, 1); assert.equal(session.snapshot().usage.totalTokens, 14); assert.equal(session.snapshot().messages.at(-1).usageReported, true);
  }
});
