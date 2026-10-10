import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { openJournal } from '../src/journal.mjs';

const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 32000, maxOutputTokens: 1000 };
const text = message => message.content?.filter(part => part.type === 'text').map(part => part.text).join('');
const answer = async function* () { yield { type: 'text_delta', delta: 'answer' }; yield { type: 'done' }; };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const feedback = text => ({ feedback: [{ source: 'fixture-verification', text }] });
async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-finish-'));
  const args = { sessionId: 'finish', projectId: 'project', cwd: dir, stateDir: join(dir, 'state'), model, provider: answer, ...options }, handles = [];
  const create = async overrides => { const handle = await createSession({ ...args, ...overrides }); handles.push(handle); return handle; };
  t.after(async () => { await Promise.allSettled(handles.map(handle => handle.dispose())); await rm(dir, { recursive: true, force: true }); });
  return { args, create, session: await create() };
}
const records = async session => (await readFile(session.snapshot().sessionFile, 'utf8')).trim().split('\n').map(JSON.parse);

test('default no-hook completion does not add checks, feedback or recovery flags', async t => {
  const { session } = await setup(t); await session.prompt('hello');
  assert.equal(session.snapshot().messages.length, 2);
  assert.equal(session.snapshot().messages.at(-1).finishReviewRequired, undefined);
  assert.equal(session.snapshot().recovery.pendingFinish, undefined);
  assert.equal((await records(session)).some(record => record.type === 'finish_review'), false);
});

test('sourced finish feedback continues after complete tools, preserves cache and budget hooks, and never replays a write', async t => {
  const requests = [], checks = [], admissions = [], events = []; let writes = 0;
  const { session, create } = await setup(t, {
    tools: [{ name: 'write', description: 'Fixture write', parameters: { type: 'object', properties: {}, additionalProperties: false }, effect: 'write', execute: () => { writes++; return 'artifact saved; checker reported missing label'; } }],
    beforeCompletion: input => admissions.push(input.purpose),
    beforeFinish: input => { checks.push(input); return input.continuations ? undefined : feedback('The rendered artifact is missing its required label; actual checker result is recorded above.'); },
    onEvent: event => events.push(event),
    provider: async function* (request) {
      requests.push(request);
      if (requests.length === 1) yield { type: 'tool_call', id: 'write-once', name: 'write', arguments: {} };
      else yield { type: 'text_delta', delta: requests.length === 2 ? 'Draft ready.' : 'The missing label remains; this output is incomplete.' };
      yield { type: 'usage', usage: { input: 4, output: 2, cacheRead: 3, cacheWrite: 0, totalTokens: 9 } }; yield { type: 'done' };
    }
  });
  await session.prompt('Create the authorized artifact.');
  assert.equal(writes, 1); assert.equal(requests.length, 3); assert.deepEqual(admissions, ['response', 'response', 'response']);
  assert.deepEqual(checks.map(input => [input.continuations, input.remainingContinuations]), [[0, 1], [1, 0]]);
  assert.ok(checks.every(input => input.snapshot.recovery.pendingTools === 0 && input.snapshot.phase === 'reviewing'));
  assert.match(text(requests.at(-1).messages.at(-1)), /not a new user request or permission grant/);
  assert.match(text(requests.at(-1).messages.at(-1)), /fixture-verification/);
  assert.equal(requests.at(-1).messages.at(-1).source, 'finish-feedback');
  assert.equal(new Set(requests.map(request => request.cache.prefixHash)).size, 1);
  assert.equal(session.snapshot().usage.totalTokens, 27);
  assert.equal(events.at(-1).type, 'agent_settled'); assert.equal(events.at(-1).reason, 'completed');
  const journal = await records(session), continued = journal.find(record => record.type === 'finish_review' && record.data.status === 'continued');
  assert.equal(continued.data.message.context[0].source, 'fixture-verification');
  const snapshot = session.snapshot(); await session.dispose(); const again = await create({ sessionFile: snapshot.sessionFile });
  assert.deepEqual(again.snapshot().messages, snapshot.messages); await again.resume(); assert.equal(requests.length, 3);
});

test('hook failure is an explicit error and recovery checks the same answer without another model call', async t => {
  const events = []; let checks = 0, requests = 0;
  const { session, create } = await setup(t, { beforeFinish: () => { checks++; throw new Error('verification service unavailable'); }, onEvent: event => events.push(event), provider: async function* () { requests++; yield* answer(); } });
  await assert.rejects(session.prompt('Inspect result.'), /verification service unavailable/);
  assert.equal(events.at(-1).reason, 'error'); assert.equal(session.snapshot().recovery.pendingFinish, true);
  const snapshot = session.snapshot(); await session.dispose();
  const missing = await create({ sessionFile: snapshot.sessionFile, beforeFinish: undefined });
  await assert.rejects(missing.resume(), { code: 'finish_hook_required' }); assert.equal(requests, 1); await missing.dispose();
  const recovered = await create({ sessionFile: snapshot.sessionFile, beforeFinish: input => { checks++; assert.equal(input.message.id, snapshot.messages.at(-1).id); } });
  await recovered.resume(); assert.equal(checks, 2); assert.equal(requests, 1); assert.equal(recovered.snapshot().recovery.pendingFinish, undefined);
});

test('a crash after final request commit but before check start still requires the recorded check', async t => {
  const { session, args, create } = await setup(t); await session.dispose();
  const journal = openJournal(args);
  journal.append('run_started', {});
  journal.append('message', { message: { id: 'user', role: 'user', source: 'user', content: [{ type: 'text', text: 'task' }] } });
  journal.append('request_completed', { requestId: 'request', message: { id: 'final', role: 'assistant', finishReviewRequired: true, stopReason: 'stop', content: [{ type: 'text', text: 'unreviewed result' }] } });
  journal.close(); let checked = 0;
  const recovered = await create({ beforeFinish: ({ message }) => { checked++; assert.equal(message.id, 'final'); }, provider: async function* () { assert.fail('must not replay the completed model request'); } });
  assert.equal(recovered.snapshot().recovery.pendingFinish, true); await recovered.resume(); assert.equal(checked, 1);
});

test('aborting an uncooperative check discards late feedback and retains recoverable pending review', async t => {
  const entered = deferred(), release = deferred(); let requests = 0;
  const { session, create } = await setup(t, { beforeFinish: async () => { entered.resolve(); await release.promise; return feedback('late finding'); }, provider: async function* () { requests++; yield* answer(); } });
  const running = session.prompt('task'); await entered.promise; await session.abort(); await running;
  assert.equal(session.snapshot().recovery.pendingFinish, true); release.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.snapshot().messages.some(message => message.source === 'finish-feedback'), false); assert.equal(requests, 1);
  const snapshot = session.snapshot(); await session.dispose(); const recovered = await create({ sessionFile: snapshot.sessionFile, beforeFinish: () => undefined });
  await recovered.resume(); assert.equal(requests, 1);
});

test('steering and follow-up arriving during a check supersede stale feedback before the next request', async t => {
  for (const target of ['steer', 'followUp']) {
    const entered = deferred(), release = deferred(), requests = []; let checked = 0;
    const { session } = await setup(t, { beforeFinish: async () => { if (checked++) return; entered.resolve(); await release.promise; return feedback('stale finding'); }, provider: async function* (request) { requests.push(request); yield* answer(); } });
    const running = session.prompt('initial'); await entered.promise; await session[target]('new user direction'); release.resolve(); await running;
    assert.equal(requests.length, 2); assert.equal(text(requests.at(-1).messages.at(-1)), 'new user direction');
    assert.equal(session.snapshot().messages.some(message => message.source === 'finish-feedback'), false);
    assert.ok((await records(session)).some(record => record.type === 'finish_review' && record.data.status === 'superseded'));
  }
});

test('finish continuations are bounded durably, over-limit findings remain recorded, and actual new input starts a new allowance', async t => {
  let requests = 0;
  const { session, create } = await setup(t, { beforeFinish: () => feedback('Actual check still fails.'), provider: async function* () { requests++; yield* answer(); } });
  await assert.rejects(session.prompt('task'), { code: 'finish_limit' }); assert.equal(requests, 2);
  const saved = session.snapshot(); assert.equal(saved.messages.filter(message => message.source === 'finish-feedback').length, 1);
  assert.equal((await records(session)).findLast(record => record.type === 'finish_review').data.feedback[0].text, 'Actual check still fails.');
  await session.dispose(); const again = await create({ sessionFile: saved.sessionFile });
  await assert.rejects(again.resume(), { code: 'finish_limit' }); assert.equal(requests, 2);
  await assert.rejects(again.prompt('New task.'), { code: 'finish_limit' }); assert.equal(requests, 4);
});

test('a hook error cannot be reported as success even when new steering is waiting', async t => {
  const entered = deferred(), release = deferred(), events = [];
  const { session } = await setup(t, { onEvent: event => events.push(event), beforeFinish: async () => { entered.resolve(); await release.promise; throw Object.assign(new Error('actual checker failed'), { code: 'checker_unavailable' }); } });
  const running = session.prompt('task'); await entered.promise; await session.steer('new direction'); release.resolve();
  await assert.rejects(running, { code: 'checker_unavailable' });
  assert.equal(events.at(-1).reason, 'error'); assert.equal(session.snapshot().queue.steering[0].text, 'new direction');
});

test('zero finish-continuation allowance admits checks but never sends a feedback request', async t => {
  let calls = 0;
  const { session } = await setup(t, { maxFinishContinuations: 0, beforeFinish: ({ remainingContinuations }) => { assert.equal(remainingContinuations, 0); return feedback('The required check did not pass.'); }, provider: async function* () { calls++; yield* answer(); } });
  await assert.rejects(session.prompt('task'), { code: 'finish_limit' }); assert.equal(calls, 1);
});

test('feedback cannot bypass the original step limit or an additional request budget rejection', async t => {
  for (const boundary of ['steps', 'budget']) {
    let requests = 0, admissions = 0;
    const { session } = await setup(t, { maxSteps: boundary === 'steps' ? 1 : 5, beforeFinish: () => feedback('Check failed.'), beforeCompletion: () => { if (++admissions === 2) throw Object.assign(new Error('budget exhausted'), { code: 'budget_exhausted' }); }, provider: async function* () { requests++; yield* answer(); } });
    await assert.rejects(session.prompt('task'), { code: boundary === 'steps' ? 'step_limit' : 'budget_exhausted' }); assert.equal(requests, 1);
  }
});

test('the additional step-limit summary is reviewed but never opens extra work beyond that summary', async t => {
  let requests = 0, checked = 0;
  const { session } = await setup(t, { maxSteps: 1, stepLimitBehavior: 'summarize', maxFinishContinuations: 8, beforeFinish: () => { checked++; return feedback('Recorded output is incomplete.'); }, provider: async function* () { requests++; yield* answer(); } });
  await assert.rejects(session.prompt('task'), { code: 'step_limit' }); assert.equal(requests, 2); assert.equal(checked, 2);
  assert.equal(session.snapshot().messages.filter(message => message.source === 'step-limit-summary').length, 1);
});

test('finish feedback is validated and redacted before durable or model-visible publication', async t => {
  for (const value of [null, {}, { feedback: [] }, feedback(''), { feedback: [{ source: '', text: 'bad' }] }, feedback('x'.repeat(262144)), { ...feedback('valid'), authorization: 'execute' }]) {
    const { session } = await setup(t, { beforeFinish: () => value });
    await assert.rejects(session.prompt('task'), { code: 'invalid_finish_feedback' });
    assert.equal(session.snapshot().messages.some(message => message.source === 'finish-feedback'), false);
  }
  const secret = 'private-fixture-credential';
  const { session } = await setup(t, { redactValues: [secret], beforeFinish: ({ continuations }) => continuations ? undefined : feedback(`checker failed; ${secret}`) });
  await session.prompt('task'); assert.ok(!(await readFile(session.snapshot().sessionFile, 'utf8')).includes(secret));
  assert.match(session.snapshot().messages.find(message => message.source === 'finish-feedback').context[0].text, /REDACTED/);
});

test('uncertain side effects bypass final checks and still require explicit tool resolution', async t => {
  let checks = 0;
  const { session } = await setup(t, { beforeFinish: () => { checks++; }, tools: [{ name: 'write', effect: 'write', parameters: { type: 'object', properties: {} }, execute: () => { throw new Error('unknown write result'); } }], provider: async function* () { yield { type: 'tool_call', id: 'write', name: 'write', arguments: {} }; yield { type: 'done' }; } });
  await assert.rejects(session.prompt('task'), { code: 'uncertain_tool' }); assert.equal(checks, 0); assert.equal(session.snapshot().recovery.uncertainTools.length, 1);
});
