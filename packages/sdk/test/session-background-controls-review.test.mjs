import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const model = { providerId: 'fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 64000, maxOutputTokens: 1000 };
const answer = async function* () { yield { type: 'text_delta', delta: 'Verified answer.' }; yield { type: 'done', stopReason: 'stop' }; };
async function fixture(t, options) {
  const directory = await mkdtemp(join(tmpdir(), 'rna-background-review-')); let session;
  const open = async () => session = await createSession({ sessionId: 'review-action', projectId: 'review-project', cwd: directory, stateDir: join(directory, 'state'), model, provider: answer, ...options });
  t.after(async () => { await session?.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { session: await open(), open };
}
const log = async session => (await readFile(session.snapshot().sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));

test('external pause during asynchronous request admission prevents an undispatched provider call', async t => {
  const entered = gate(), release = gate(); let calls = 0;
  const f = await fixture(t, { beforeCompletion: async ({ purpose }) => { if (purpose === 'response') { entered.resolve(); await release.promise; } }, provider: async function* () { calls++; yield* answer(); } });
  const operation = f.session.prompt('Inspect the project.'); await entered.promise;
  await f.session.yieldAtBoundary({ requestId: 'during-admission' }); release.resolve(); await operation;
  assert.equal(calls, 0, 'a completed budget/admission wait cannot dispatch after a control boundary was requested');
  assert.equal(f.session.snapshot().continuation?.reason, 'control');
});

test('withdrawn durable steering stays withdrawn across retry and reopening', async t => {
  let calls = 0;
  const f = await fixture(t, { provider: async function* () { calls++; yield* answer(); } });
  const receipt = await f.session.steer('Superseded instruction', { requestId: 'withdraw-once', wake: false });
  assert.equal(await f.session.withdraw(receipt.id), true); await f.session.dispose(); f.session = await f.open();
  assert.deepEqual(await f.session.steer('Superseded instruction', { requestId: 'withdraw-once', wake: false }), receipt);
  await f.session.resume(); assert.equal(calls, 0); assert.equal(f.session.snapshot().queue.steering.length, 0);
  assert.equal((await log(f.session)).filter(row => row.type === 'inbox_added').length, 1);
});

test('simultaneous resume calls never create overlapping provider requests from one paused journal', async t => {
  let calls = 0; const entered = gate(), release = gate();
  const f = await fixture(t, { provider: async function* () { calls++; entered.resolve(); await release.promise; yield* answer(); } });
  await f.session.steer('Continue retained instruction', { requestId: 'resume-input', wake: false }); await f.session.yieldAtBoundary({ requestId: 'before-first-call' });
  const one = f.session.resume(), two = f.session.resume(); const results = Promise.allSettled([one, two]);
  await entered.promise; assert.equal(calls, 1); release.resolve(); const settled = await results;
  assert.equal(settled.filter(row => row.status === 'fulfilled').length, 1); assert.equal(settled.find(row => row.status === 'rejected').reason.code, 'busy');
  assert.equal(calls, 1); assert.equal((await log(f.session)).filter(row => row.type === 'request_started').length, 1);
});

test('pause during final response validation is settled on that run rather than leaking into a later prompt', async t => {
  const entered = gate(), release = gate(); let calls = 0, checks = 0;
  const f = await fixture(t, { beforeFinish: async () => { if (++checks === 1) { entered.resolve(); await release.promise; } }, provider: async function* () { calls++; yield* answer(); } });
  const operation = f.session.prompt('Verify the first result.'); await entered.promise;
  await f.session.yieldAtBoundary({ requestId: 'during-validation' }); release.resolve(); await operation;
  assert.equal(f.session.snapshot().continuation?.reason, 'control', 'the pause must belong to the currently validating run');
  await f.session.resume(); assert.equal(calls, 1, 'accepted final response is retained without generating again');
  await f.session.prompt('A separate new instruction.'); assert.equal(calls, 2, 'old boundary cannot pause this later instruction');
});

test('pause during compaction admission avoids the summary request and does not claim a compaction occurred', async t => {
  const entered = gate(), release = gate(); let summaries = 0;
  const f = await fixture(t, { autoCompaction: false, beforeCompletion: async ({ purpose }) => { if (purpose === 'compaction') { entered.resolve(); await release.promise; } }, provider: async function* requestProvider(request) {
    if (request.systemPrompt.startsWith('Summarize the provided conversation')) { summaries++; yield { type: 'text_delta', delta: 'Previous verified work and outstanding requirements.' }; }
    else yield { type: 'text_delta', delta: 'Verified project evidence. '.repeat(180) };
    yield { type: 'done', stopReason: 'stop' };
  } });
  await f.session.prompt('First instruction'); await f.session.prompt('Second instruction'); await f.session.prompt('Third instruction');
  const operation = f.session.compact({ generate: true, keepLastTurns: 1 }); await entered.promise;
  await f.session.yieldAtBoundary({ requestId: 'during-summary-admission' }); release.resolve(); const result = await operation;
  assert.equal(summaries, 0, 'the provider had not started when pause was requested'); assert.equal(result.compacted, false); assert.equal(f.session.snapshot().compaction, null);
});

test('a crash after boundary admission but before its yield receipt cannot carry the old pause into a later instruction', async t => {
  let calls = 0;
  const f = await fixture(t, { provider: async function* () { calls++; yield* answer(); } });
  await f.session.prompt('Completed original instruction'); await f.session.yieldAtBoundary({ requestId: 'crash-after-admission' });
  const path = f.session.snapshot().sessionFile, rows = await log(f.session), boundary = rows.findIndex(row => row.type === 'boundary_requested');
  await f.session.dispose();
  // A complete committed prefix models a crash between two canonical fsyncs.
  // The original answer and accepted boundary remain intact, with no made-up
  // receipt confirming that the requested yield actually finished.
  await writeFile(path, rows.slice(0, boundary + 1).map(row => JSON.stringify(row)).join('\n') + '\n');
  f.session = await f.open(); await f.session.resume();
  assert.equal(calls, 1); assert.equal(f.session.snapshot().continuation?.reason, 'control', 'the accepted boundary must be folded before a completed-answer fast return');
  await f.session.resume(); await f.session.prompt('Independent later instruction'); assert.equal(calls, 2);
});
