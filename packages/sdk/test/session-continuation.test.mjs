import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createSession } from '../src/session.mjs';

const model = { providerId: 'test', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 64000, maxOutputTokens: 1000, reasoning: 'off' };
const tick = () => new Promise(resolve => setImmediate(resolve));
const text = message => message.content?.filter(part => part.type === 'text').map(part => part.text).join('');
const answer = async function* () { yield { type: 'text_delta', delta: 'Complete.' }; yield { type: 'done', stopReason: 'stop' }; };
const command = (execute, extra = {}) => ({ name: 'work', description: 'Fixture operation', parameters: { type: 'object', properties: {}, additionalProperties: false }, effect: 'write', execute, ...extra });
async function setup(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-continuation-')), handles = [];
  const options = { sessionId: 'session', projectId: 'project', cwd: dir, stateDir: join(dir, 'state'), model, maxSteps: 1, stepLimitBehavior: 'yield', provider: answer, ...overrides };
  const create = async changes => { const session = await createSession({ ...options, ...changes }); handles.push(session); return session; };
  t.after(async () => { await Promise.allSettled(handles.map(handle => handle.dispose())); await rm(dir, { recursive: true, force: true }); });
  return { dir, options, create, session: await create() };
}
const records = async file => (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));

test('bounded slices finish complete tool batches, preserve cache/input and never replay completed effects', async t => {
  const calls = [], requests = [], events = [], admissions = [], settled = [];
  const { session } = await setup(t, { maxSteps: 2, onEvent: event => events.push(event), afterRun: ({ reason }) => settled.push(reason), beforeCompletion: input => admissions.push(input), tools: [command(id => { calls.push(id); return `receipt-${id}`; })], provider: async function* (request) {
    requests.push(request);
    if (requests.length <= 6) yield { type: 'tool_call', id: `call-${requests.length}`, name: 'work', arguments: {} };
    else yield { type: 'text_delta', delta: 'All recorded work complete.' };
    yield { type: 'usage', usage: { input: 2, output: 1, totalTokens: 3 } };
    yield { type: 'done' };
  } });
  await session.prompt('Perform six operations.');
  const receipts = [];
  while (session.snapshot().continuation) {
    const snapshot = session.snapshot(); receipts.push(snapshot.continuation);
    assert.equal(snapshot.idle, true); assert.equal(snapshot.recovery.pendingTools, 0); assert.deepEqual(snapshot.recovery.uncertainTools, []);
    assert.equal(snapshot.continuation.steps, 2); assert.equal(snapshot.continuation.maxSteps, 2);
    const priorCalls = requests.length; await tick(); assert.equal(requests.length, priorCalls, 'yield does not schedule its own request');
    await session.resume();
  }
  assert.equal(receipts.length, 3); assert.equal(new Set(receipts.map(item => item.id)).size, 3);
  assert.equal(requests.length, 7); assert.equal(admissions.length, 7); assert.equal(session.snapshot().usage.totalTokens, 21);
  assert.deepEqual(calls, Array.from({ length: 6 }, (_, index) => `call-${index + 1}`));
  assert.deepEqual(settled, ['yielded', 'yielded', 'yielded', 'completed']);
  assert.deepEqual(session.snapshot().messages.filter(message => message.role === 'user').map(text), ['Perform six operations.']);
  for (const request of requests) {
    assert.equal(request.cache.prefixHash, requests[0].cache.prefixHash);
    assert.equal(request.cache.sessionKey, requests[0].cache.sessionKey);
    const ids = request.messages.flatMap(message => message.role === 'assistant' ? message.content.filter(part => part.type === 'toolCall').map(part => part.id) : []);
    assert.deepEqual(request.messages.filter(message => message.role === 'toolResult').map(message => message.toolCallId), ids);
  }
  const log = await records(session.snapshot().sessionFile);
  assert.deepEqual(log.filter(row => row.type === 'run_yielded').map(row => row.data.continuation.id), receipts.map(item => item.id));
  assert.deepEqual(log.filter(row => row.type === 'run_started').slice(1).map(row => row.data.continuationId), receipts.map(item => item.id));
  assert.deepEqual(events.filter(event => event.type === 'agent_settled').map(event => event.reason), settled);
  assert.equal(log.filter(row => row.type === 'request_started').length, 7);
});

test('steering at the last batch boundary and later follow-up remain queued until explicit same-log continuation', async t => {
  let requests = 0, executed = 0, session;
  const inputs = [];
  const fixture = await setup(t, { tools: [command(async () => { executed++; await session.steer('Change direction.'); return 'confirmed'; })], provider: async function* (request) {
    requests++; inputs.push(request.messages.filter(message => message.role === 'user').map(text));
    if (requests === 1) {
      yield { type: 'tool_call', id: 'first', name: 'work', arguments: {} };
      yield { type: 'tool_call', id: 'cancelled-before-start', name: 'work', arguments: {} };
    } else yield { type: 'text_delta', delta: 'Answer to latest input.' };
    yield { type: 'done' };
  } }); session = fixture.session;
  await session.prompt('Original task.');
  assert.equal(executed, 1); assert.equal(requests, 1); assert.equal(session.snapshot().queue.steering.length, 1);
  await session.followUp('Also explain the result.'); await tick(); assert.equal(requests, 1);
  const saved = session.snapshot(); await session.dispose(); session = await fixture.create({ sessionFile: saved.sessionFile });
  assert.deepEqual(session.snapshot().continuation, saved.continuation);
  await session.resume(); assert.equal(requests, 2); assert.ok(session.snapshot().continuation);
  await session.resume(); assert.equal(requests, 3); assert.equal(session.snapshot().continuation, undefined);
  assert.equal(executed, 1); assert.deepEqual(inputs[2], ['Original task.', 'Change direction.', 'Also explain the result.']);
  assert.deepEqual(session.snapshot().messages.filter(message => message.source === 'resume'), []);
  const log = await records(saved.sessionFile);
  assert.equal(log.filter(row => row.type === 'inbox_claimed').length, 2);
  assert.equal(log.filter(row => row.type === 'tool_intent').length, 1);
  const cancelled = session.snapshot().messages.find(message => message.toolCallId === 'cancelled-before-start');
  assert.equal(cancelled.isError, true); assert.match(text(cancelled), /canceled before execution/);
});

test('abort takes precedence before and during the durable yield event without another request', async t => {
  for (const boundary of ['turn_end', 'run_yielded']) await t.test(boundary, async t => {
    let requests = 0, session; const reasons = [];
    const fixture = await setup(t, { tools: [command(() => 'complete')], onEvent(event) {
      if (event.type === boundary) void session.abort();
      if (event.type === 'agent_settled') reasons.push(event.reason);
    }, provider: async function* () { requests++; yield { type: 'tool_call', id: 'one', name: 'work', arguments: {} }; yield { type: 'done' }; } }); session = fixture.session;
    await session.prompt('Work until stopped.'); await tick();
    assert.equal(requests, 1); assert.deepEqual(reasons, ['aborted']); assert.equal(session.snapshot().recovery.pendingTools, 0);
    assert.equal(Boolean(session.snapshot().continuation), boundary === 'run_yielded');
    await session.abort(); await tick(); assert.equal(requests, 1, 'idle abort never resumes a saved boundary');
  });
});

test('every resumed slice rechecks admission; exhausted budget never becomes another yield or model request', async t => {
  let admissions = 0, requests = 0, executions = 0;
  const { session } = await setup(t, { beforeCompletion() { if (++admissions === 2) throw Object.assign(new Error('Measured budget exhausted.'), { code: 'budget_exhausted' }); }, tools: [command(() => { executions++; return 'committed'; })], provider: async function* () { requests++; yield { type: 'tool_call', id: `call-${requests}`, name: 'work', arguments: {} }; yield { type: 'done' }; } });
  await session.prompt('Bounded work.'); assert.ok(session.snapshot().continuation);
  await assert.rejects(session.resume(), { code: 'budget_exhausted' });
  assert.equal(admissions, 2); assert.equal(requests, 1); assert.equal(executions, 1); assert.equal(session.snapshot().continuation, undefined);
  assert.equal(session.snapshot().messages.filter(message => message.role === 'user').length, 1);
  const log = await records(session.snapshot().sessionFile);
  assert.equal(log.filter(row => row.type === 'request_started').length, 1);
  assert.deepEqual(log.filter(row => row.type === 'run_settled').at(-1).data, { reason: 'error', code: 'budget_exhausted' });
});

test('a resumed slice keeps the uncertainty fence and cannot replay a possibly completed write', async t => {
  let requests = 0, executions = 0;
  const { session, create } = await setup(t, { tools: [command(() => { if (++executions === 2) throw new Error('Lost write receipt.'); return 'first confirmed'; })], provider: async function* () { requests++; yield { type: 'tool_call', id: `operation-${requests}`, name: 'work', arguments: {} }; yield { type: 'done' }; } });
  await session.prompt('Work.'); await assert.rejects(session.resume(), { code: 'uncertain_tool' });
  const saved = session.snapshot(); assert.equal(saved.continuation, undefined); assert.equal(saved.recovery.uncertainTools.length, 1);
  await session.dispose(); const reopened = await create({ sessionFile: saved.sessionFile });
  await assert.rejects(reopened.resume(), { code: 'uncertain_tool' });
  assert.equal(requests, 2); assert.equal(executions, 2);
});

test('a cancelled next-slice preparation cannot invoke the provider or replay a prior tool', async t => {
  let requests = 0, preparations = 0, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const { session } = await setup(t, { beforeRequest: async () => { if (++preparations === 2) { entered(); await new Promise(() => {}); } }, tools: [command(() => 'committed')], provider: async function* () { requests++; yield { type: 'tool_call', id: 'first', name: 'work', arguments: {} }; yield { type: 'done' }; } });
  await session.prompt('Work.'); const next = session.resume(); await waiting; await session.abort(); await next;
  assert.equal(requests, 1); assert.equal(session.snapshot().continuation, undefined); assert.equal(session.snapshot().recovery.pendingTools, 0);
  assert.equal((await records(session.snapshot().sessionFile)).filter(row => row.type === 'run_settled').at(-1).data.reason, 'aborted');
});

test('finish feedback allowance remains durable across yield and reopen', async t => {
  let requests = 0;
  const { session, create } = await setup(t, { maxFinishContinuations: 1, beforeFinish: () => ({ feedback: [{ source: 'verified-fixture', text: 'A specific observed defect remains.' }] }), provider: async function* () { requests++; yield* answer(); } });
  await session.prompt('Resolve the observed defect.'); const saved = session.snapshot(); assert.ok(saved.continuation);
  await session.dispose(); const reopened = await create({ sessionFile: saved.sessionFile });
  await assert.rejects(reopened.resume(), { code: 'finish_limit' });
  assert.equal(requests, 2); assert.equal(reopened.snapshot().continuation, undefined);
  assert.equal(reopened.snapshot().messages.filter(message => message.source === 'finish-feedback').length, 1);
});

test('withdrawing the only boundary steering settles the durable continuation without a synthetic request', async t => {
  let requests = 0, session, queued;
  const fixture = await setup(t, { onEvent(event) { if (event.type === 'turn_end' && !queued) queued = session.steer('Withdraw this.'); }, provider: async function* () { requests++; yield* answer(); } }); session = fixture.session;
  await session.prompt('Finish.'); assert.ok(session.snapshot().continuation);
  await session.withdraw((await queued).id); await session.resume();
  assert.equal(requests, 1); assert.equal(session.snapshot().continuation, undefined);
  assert.equal(session.snapshot().messages.filter(message => message.role === 'user').length, 1);
});

test('a natural answer at the configured limit completes normally without a continuation', async t => {
  const events = [], { session } = await setup(t, { onEvent: event => events.push(event) });
  await session.prompt('Answer once.');
  assert.equal(session.snapshot().continuation, undefined); assert.equal(events.at(-1).reason, 'completed');
  assert.equal(events.some(event => event.type === 'run_yielded'), false);
});

test('SIGKILL after the canonical yield receipt reopens without repeating the committed effect', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-continuation-crash-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { sessionId: 'crash-session', projectId: 'crash-project', cwd: dir, stateDir: join(dir, 'state'), model, maxSteps: 1, stepLimitBehavior: 'yield' };
  const file = join(dir, 'effect.txt');
  const code = `import {createSession} from ${JSON.stringify(new URL('../src/session.mjs', import.meta.url).href)};
    import {appendFileSync} from 'node:fs';
    const session = await createSession({...${JSON.stringify(options)},
      tools:[{name:'work',description:'fixture',parameters:{type:'object',properties:{}},effect:'write',execute(){appendFileSync(${JSON.stringify(file)},'once\\n');return 'committed';}}],
      provider:async function*(){yield {type:'tool_call',id:'effect',name:'work',arguments:{}};yield {type:'done'};},
      onEvent(event){if(event.type==='run_yielded')process.kill(process.pid,'SIGKILL');}
    }); await session.prompt('Perform the operation once.');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const [exit, signal] = await once(child, 'close'); assert.equal(exit, null, stderr); assert.equal(signal, 'SIGKILL', stderr);
  let requests = 0, repeated = 0;
  const session = await createSession({ ...options, tools: [command(() => { repeated++; return 'must not run'; })], provider: async function* (request) {
    requests++; assert.equal(request.messages.filter(message => message.role === 'toolResult').length, 1); yield* answer();
  } }); t.after(() => session.dispose());
  const before = session.snapshot(); assert.ok(before.continuation); assert.equal(before.recovery.interrupted, true);
  assert.equal((await records(before.sessionFile)).some(row => row.type === 'run_settled'), false);
  await session.resume();
  assert.equal(requests, 1); assert.equal(repeated, 0); assert.equal(await readFile(file, 'utf8'), 'once\n');
  assert.equal(session.snapshot().continuation, undefined); assert.equal(session.snapshot().recovery.interrupted, false);
  assert.equal(session.snapshot().messages.filter(message => message.source === 'resume').length, 0);
});
