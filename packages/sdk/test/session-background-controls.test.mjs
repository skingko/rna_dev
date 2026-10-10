import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
const gate = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve: (...args) => resolve(...args) }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 64000, maxOutputTokens: 1000 };
const answer = async function* () { yield { type: 'text_delta', delta: 'Done.' }; yield { type: 'done', stopReason: 'stop' }; };
const tool = execute => ({ name: 'work', description: 'Deterministic fixture operation', effect: 'write', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute });
async function fixture(t, changes = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rna-background-session-')), handles = [];
  const options = { sessionId: 'owned-action', projectId: 'project', cwd: directory, stateDir: join(directory, 'state'), model, provider: answer, ...changes };
  const open = async () => { const handle = await createSession(options); handles.push(handle); return handle; };
  t.after(async () => { await Promise.allSettled(handles.map(h => h.dispose())); await rm(directory, { recursive: true, force: true }); });
  return { session: await open(), open };
}
const log = async session => (await readFile(session.snapshot().sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));

test('durable steering is exactly once before and after inbox consumption and reopening, without idle wake', async t => {
  let calls = 0;
  const f = await fixture(t, { provider: async function* () { calls++; yield* answer(); } });
  const receipt = await f.session.steer('Inspect official sources.', { requestId: 'control:1', wake: false });
  await tick(); assert.equal(calls, 0);
  assert.deepEqual(await f.session.steer('Inspect official sources.', { requestId: 'control:1', wake: false }), receipt);
  await assert.rejects(f.session.steer('Changed payload.', { requestId: 'control:1', wake: false }), { code: 'input_conflict' });
  await f.session.resume(); assert.equal(calls, 1); assert.equal(f.session.snapshot().queue.steering.length, 0);
  await f.session.dispose(); f.session = await f.open();
  assert.deepEqual(await f.session.steer('Inspect official sources.', { requestId: 'control:1', wake: false }), receipt);
  await tick(); assert.equal(calls, 1); assert.equal(f.session.snapshot().queue.steering.length, 0);
  assert.equal((await log(f.session)).filter(row => row.type === 'inbox_added').length, 1);
});

test('a pending control stops before newly generated tools dispatch, then resumes them once in the same journal', async t => {
  const entered = gate(), release = gate(); let calls = 0, executed = 0;
  const f = await fixture(t, { tools: [tool(() => { executed++; return 'committed'; })], provider: async function* () {
    if (++calls === 1) { entered.resolve(); await release.promise; yield { type: 'tool_call', id: 'write-once', name: 'work', arguments: {} }; yield { type: 'done' }; }
    else yield* answer();
  } });
  const operation = f.session.prompt('Complete the fixture.'); await entered.promise;
  await f.session.yieldAtBoundary({ requestId: 'pause-1' }); release.resolve(); await operation;
  assert.equal(executed, 0); assert.equal(f.session.snapshot().continuation.reason, 'control'); assert.equal(f.session.snapshot().recovery.pendingTools, 1);
  await f.session.dispose(); f.session = await f.open();
  await f.session.resume(); assert.equal(executed, 1); assert.equal(calls, 2);
  await f.session.yieldAtBoundary({ requestId: 'pause-1' }); assert.equal(f.session.snapshot().continuation, undefined, 'old boundary id cannot pause again');
  await f.session.resume(); assert.equal(executed, 1); assert.equal(calls, 2);
});

test('a started mutation drains without abort and completed tools do not repeat on continuation', async t => {
  const entered = gate(), release = gate(); let calls = 0, executed = 0, toolSignal;
  const f = await fixture(t, { tools: [tool(async (_id, _args, signal) => { executed++; toolSignal = signal; entered.resolve(); await release.promise; return 'verified'; })], provider: async function* () {
    if (++calls === 1) { yield { type: 'tool_call', id: 'mutation', name: 'work', arguments: {} }; yield { type: 'done' }; }
    else yield* answer();
  } });
  const operation = f.session.prompt('Work.'); await entered.promise;
  await f.session.yieldAtBoundary({ requestId: 'pause-writing' }); assert.equal(toolSignal.aborted, false);
  release.resolve(); await operation;
  assert.equal(calls, 1); assert.equal(f.session.snapshot().recovery.pendingTools, 0);
  await f.session.resume(); assert.equal(executed, 1); assert.equal(calls, 2);
});

test('pausing at the step ceiling yields without generating a summary or throwing a limit error', async t => {
  let session, calls = 0;
  const f = await fixture(t, { maxSteps: 1, stepLimitBehavior: 'error', tools: [tool(async () => { await session.yieldAtBoundary({ requestId: 'last-step' }); return 'complete'; })], provider: async function* () { calls++; yield { type: 'tool_call', id: 'last', name: 'work', arguments: {} }; yield { type: 'done' }; } }); session = f.session;
  await session.prompt('Work.'); assert.equal(calls, 1); assert.equal(session.snapshot().continuation.reason, 'control');
});

test('a request preparation pause never calls the provider', async t => {
  let session, calls = 0;
  const f = await fixture(t, { beforeRequest: async () => { await session.yieldAtBoundary({ requestId: 'preparing' }); }, provider: async function* () { calls++; yield* answer(); } }); session = f.session;
  await session.prompt('Work.'); assert.equal(calls, 0); assert.equal(session.snapshot().continuation.reason, 'control');
  await session.resume(); assert.equal(calls, 1, 'same request id is not a fresh pause');
});

test('a complete answer retained at a control boundary needs no new request when resumed', async t => {
  const entered = gate(), release = gate(); let calls = 0;
  const f = await fixture(t, { provider: async function* () { calls++; entered.resolve(); await release.promise; yield* answer(); } });
  const operation = f.session.prompt('Summarize.'); await entered.promise;
  await f.session.yieldAtBoundary({ requestId: 'final-answer' }); release.resolve(); await operation;
  assert.equal(f.session.snapshot().continuation.reason, 'control');
  await f.session.dispose(); f.session = await f.open(); await f.session.resume(); assert.equal(calls, 1);
});

test('unknown mutation outcomes remain blocked even when a pause was requested', async t => {
  let session;
  const f = await fixture(t, { tools: [tool(async () => { await session.yieldAtBoundary({ requestId: 'pause-unknown' }); throw new Error('Outcome unknown'); })], provider: async function* () { yield { type: 'tool_call', id: 'unknown', name: 'work', arguments: {} }; yield { type: 'done' }; } }); session = f.session;
  await assert.rejects(session.prompt('Work.'), { code: 'uncertain_tool' });
  assert.equal(session.snapshot().recovery.uncertainTools.length, 1);
  await session.dispose(); session = await f.open();
  await assert.rejects(session.resume(), { code: 'uncertain_tool' });
});
