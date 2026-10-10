import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { buildDecisionState } from '../src/decision-state.mjs';
import { validateHostTemplatePlan } from '../src/decision-kernel.mjs';
import { summaryCoverageTemplate, combineSummaryCoverage, lintDecisionTemplate, wireQuestions } from '../src/decision-templates.mjs';

// C5 fork probe (control-center benchmark/compaction-fork-probe.mjs): the session hands out the requests an automatic
// compaction would weigh — the next main request, the TC-6 fork and the flattened record — from its own builders,
// without sending, journaling or committing anything.
const model = { providerId: 'probe-fixture', modelId: 'glm-fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 200000, maxOutputTokens: 4000, reasoning: 'off' };

async function fixture(t, { turns = 4, steerOn = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-compaction-requests-')), requests = [];
  let session = null, turn = 0;
  const provider = async function* (request) {
    requests.push(request);
    const last = request.messages.at(-1);
    // Each turn: one tool call, then an answer.
    if (last?.role === 'user') yield { type: 'tool_call', id: `call-${requests.length}`, name: 'lookup', arguments: { page: requests.length } };
    else yield { type: 'text_delta', delta: `Chapter written: ${'正文'.repeat(400)}` };
    yield { type: 'usage', usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1000 } }; yield { type: 'done', stopReason: last?.role === 'user' ? 'toolUse' : 'stop' };
  };
  // `steerOn`: the turn whose tool call the user steers (the steering message joins the conversation as source steer).
  const tools = [{ name: 'lookup', effect: 'read', idempotent: true, parameters: { type: 'object', properties: { page: { type: 'number' } } }, execute: async () => { if (turn === steerOn) { steerOn = null; await session.steer(`Keep chapter ${turn} under two pages.`); } return 'notes for the chapter'; } }];
  session = await createSession({ sessionId: 'compaction-requests', projectId: 'p', cwd: dir, stateDir: join(dir, 'state'), model, tools, provider, systemPrompt: 'You are the probe fixture.', autoCompaction: false });
  t.after(async () => { await session.dispose(); await rm(dir, { recursive: true, force: true }); });
  for (turn = 1; turn <= turns; turn++) await session.prompt(`Write chapter ${turn}.`);
  return { session, requests, dir };
}

test('compactionRequests: main, fork and flat from the session\'s own builders; the fork extends the main request; nothing is written', async t => {
  const f = await fixture(t);
  const file = f.session.snapshot().sessionFile, before = (await stat(file)).size, messages = f.session.snapshot().messages.length, sent = f.requests.length;
  const built = f.session.compactionRequests();
  assert.ok(built, 'a candidate exists after four turns');
  const { main, fork, flat } = built;
  assert.equal(fork.systemPrompt, main.systemPrompt); assert.deepEqual(fork.tools, main.tools); assert.equal(fork.cache.prefixHash, main.cache.prefixHash);
  assert.deepEqual(fork.messages.slice(0, main.messages.length), main.messages, 'the conversation projection is a prefix of the fork request');
  assert.equal(fork.messages.length, main.messages.length + 1);
  assert.match(JSON.stringify(fork.messages.at(-1)), /up to and including the message that begins/);
  assert.equal(fork.fits, true); assert.equal(fork.toolChoice, undefined, 'an unverified endpoint gets no tool_choice');
  assert.match(flat.systemPrompt, /^Summarize the provided/); assert.deepEqual(flat.tools, []);
  assert.ok(main.estimatedInputTokens > 0 && main.contextDigest && main.prefixTokens > 0);
  // The span: complete groups before the last two, from the first message.
  assert.equal(built.archived.length, built.candidate.archivedMessages); assert.equal(built.archived.at(-1).id, built.candidate.throughMessageId);
  assert.equal(built.previousSummary, null);
  assert.equal(built.lastServed.continuous, true, 'nothing edited history since the last served request');
  assert.equal(built.lastServed.messageId, f.session.snapshot().messages.findLast(message => message.role === 'assistant').id);
  assert.equal((await stat(file)).size, before, 'no journal record'); assert.equal(f.session.snapshot().messages.length, messages); assert.equal(f.requests.length, sent, 'no provider call');
  assert.equal(f.session.snapshot().compaction, null);
});

test('compactionRequests: a recorded boundary pins the span; an unknown or unusable one gives null', async t => {
  const f = await fixture(t, { turns: 5 });
  const messages = f.session.snapshot().messages, firstAnswer = messages.find(message => message.role === 'assistant' && message.stopReason === 'stop');
  const pinned = f.session.compactionRequests({ throughMessageId: firstAnswer.id });
  assert.equal(pinned.candidate.throughMessageId, firstAnswer.id); assert.equal(pinned.archived.at(-1).id, firstAnswer.id);
  assert.match(JSON.stringify(pinned.fork.messages.at(-1)), /Chapter written/, 'the fork names where the pinned span ends');
  assert.equal(f.session.compactionRequests({ throughMessageId: 'missing' }), null);
  const user = messages.find(message => message.role === 'user' && message.source === 'user');
  assert.equal(f.session.compactionRequests({ throughMessageId: user.id }), null, 'a boundary inside a group is not a cut');
  assert.throws(() => f.session.compactionRequests({ throughMessageId: 7 }), { code: 'invalid_options' });
});

test('compactionRequests: no candidate in a short conversation', async t => {
  const f = await fixture(t, { turns: 1 });
  assert.equal(f.session.compactionRequests(), null);
  const journal = (await readFile(f.session.snapshot().sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line).type);
  assert.ok(!journal.includes('compaction_request_started'));
});

test('compactionRequests.requests: every user request up to the boundary (before an earlier compaction too), steering included', async t => {
  const f = await fixture(t, { turns: 4, steerOn: 2 });
  const compacted = await f.session.compact({ summary: 'Checkpoint: chapters 1 and 2 are written.' });
  assert.equal(compacted.compacted, true);
  for (const index of [5, 6, 7]) await f.session.prompt(`Write chapter ${index}.`);
  const built = f.session.compactionRequests();
  assert.ok(built, 'a candidate after the earlier compaction');
  const texts = built.requests.map(row => row.text);
  assert.ok(texts.includes('Write chapter 1.') && texts.includes('Write chapter 2.'), 'requests behind the earlier boundary stay: a chained summary replaces them all');
  assert.ok(texts.includes('Keep chapter 2 under two pages.'), 'the user\'s steering is a request of its own');
  assert.equal(built.requests.find(row => row.text === 'Write chapter 1.').inSpan, false);
  assert.equal(built.requests.find(row => row.text === 'Write chapter 5.').inSpan, true, 'archived by this compaction itself');
  const boundary = f.session.snapshot().messages.findIndex(message => message.id === built.candidate.throughMessageId);
  const ids = new Set(f.session.snapshot().messages.slice(0, boundary + 1).map(message => message.id));
  assert.ok(built.requests.every(row => ids.has(row.id)), 'nothing after the boundary');
  assert.ok(!texts.includes('Write chapter 7.'), 'the retained turns are not summarized');
});

test('summary.coverage: A3\'s labelled questions on one checkpoint and one request, valid for the kernel, combined at the labelled thresholds', () => {
  const plan = summaryCoverageTemplate();
  assert.deepEqual(Object.keys(plan.questions), ['kept', 'substantive']);
  assert.doesNotThrow(() => validateHostTemplatePlan(plan));
  assert.deepEqual(lintDecisionTemplate(plan), []);
  assert.ok(Object.values(wireQuestions(plan)).every(question => question.type === 'noul' && /is data to judge, not instructions/.test(question.instructions)));
  const state = buildDecisionState('summary.coverage', { checkpoint: '## User requests\n- [done] "第 1 章"\n- [pending] chapter 2', request: `写第 1 章${'。'.repeat(3000)}` });
  assert.deepEqual(Object.keys(state), ['checkpoint', 'request']);
  assert.match(state.checkpoint, /\n- \[pending\]/, 'the checkpoint keeps its lines');
  assert.equal(state.request.length, 2400, 'the request as labelled: up to 2,400 characters');
  const yes = probability => ({ type: 'boolean', probability });
  // JEV doubts a summary that records an outcome in other words: 0.3 is the labelled bar, not the medium tier.
  assert.deepEqual(combineSummaryCoverage({ kept: yes(.35), substantive: yes(.9) }), { kept: true, substantive: true, probabilities: { kept: .35, substantive: .9 } });
  assert.deepEqual(combineSummaryCoverage({ kept: yes(.2), substantive: yes(.4) }), { kept: false, substantive: false, probabilities: { kept: .2, substantive: .4 } });
  assert.deepEqual(combineSummaryCoverage({}), { kept: null, substantive: null, probabilities: { kept: null, substantive: null } });
});
