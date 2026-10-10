import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { generatePlanSummary } from '../src/compaction-request.mjs';
import { joinSplitSummary, splitTurnCandidate, TURN_PREFIX_DIRECTIVE, SPLIT_TURN_HEADING } from '../src/split-turn.mjs';
import { SUMMARY_PROMPT, compactionCuts } from '../src/context.mjs';

// Plan C5, pi's split turn (compaction.ts findCutPoint :468-521 `isSplitTurn`, prepareCompaction :907-952 and the turn
// prefix summary :964-976). An idle compaction keeps the last two turns verbatim (user decision 2026-10-04 #3). When those
// turns are themselves so large that the projection stays above the idle trigger, the plan used to be empty and the
// conversation stayed above it for good. The one exception: the earliest retained turn's beginning, only as much of it as
// brings the projection within the target, is summarized on its own. Fake provider only.
const model = { providerId: 'split-fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 400000, maxOutputTokens: 2000, reasoning: 'off' };
const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 };
const GROUPS = 4;

/** Turns of four tool batches each (a ~4.5k-token result per batch), then an answer: a turn is ~18k tokens. */
async function fixture(t, { turns = 4 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-idle-split-')), requests = [];
  t.after(() => rm(dir, { recursive: true, force: true }));
  const provider = async function* (request) {
    requests.push(request);
    const last = request.messages.findLastIndex(message => message.role === 'user' && message.source !== 'context' && message.source !== 'compaction');
    const results = request.messages.slice(last + 1).filter(message => message.role === 'toolResult' || message.role === 'tool').length;
    if (request.systemPrompt.startsWith('Summarize the provided')) yield { type: 'text_delta', delta: 'Summary.' };
    else if (results < GROUPS) yield { type: 'tool_call', id: `call-${request.messages.length}`, name: 'inspect', arguments: { n: results + 1 } };
    else yield { type: 'text_delta', delta: 'Done with this chapter.' };
    yield { type: 'usage', usage }; yield { type: 'done', stopReason: 'stop' };
  };
  const tools = [{ name: 'inspect', effect: 'read', description: 'Read a source.', parameters: { type: 'object', properties: { n: { type: 'number' } }, additionalProperties: false }, execute: async (_id, args) => `source ${args.n}: ${'资料行。'.repeat(1500)}` }];
  const session = await createSession({ sessionId: 'idle-split', projectId: 'p', cwd: dir, stateDir: join(dir, 'state'), model, tools, provider, autoCompaction: false });
  t.after(() => session.dispose());
  for (let index = 1; index <= turns; index++) await session.prompt(`Chapter ${index}: check the sources.`);
  return { session, requests, dir };
}
const indexOf = (session, id) => session.snapshot().messages.findIndex(message => message.id === id);
const turnStart = (session, number) => session.snapshot().messages.findIndex(message => message.role === 'user' && message.source === 'user' && message.content[0].text.startsWith(`Chapter ${number}:`));
const requestText = entry => entry.request.messages[0].content[0].text;
const prepared = (plan, summary, id = 'idle-request-1') => ({ id, sessionId: plan.sessionId, trigger: 'idle', previousCompactionId: plan.previousCompactionId, throughMessageId: plan.throughMessageId, sourceDigest: plan.sourceDigest, summary, archivedMessages: plan.archivedMessages, retainedMessages: plan.retainedMessages, requestId: 'req-1', usage, usageReported: true, model: plan.model });

test('without a target the plan is unchanged; with one it is only split when the ordinary plan would stay above it', async t => {
  const f = await fixture(t, { turns: 2 });
  assert.equal(f.session.prepareCompaction(), null, 'two turns, keep two: nothing older (as before)');
  const g = await fixture(t, { turns: 4 });
  const ordinary = g.session.prepareCompaction();
  assert.equal(ordinary.split, undefined); assert.equal(ordinary.requests.length, 1); assert.equal(ordinary.requests[0].kind, 'summary'); assert.deepEqual(ordinary.request, ordinary.requests[0].request);
  assert.equal(indexOf(g.session, ordinary.throughMessageId) + 1, turnStart(g.session, 3), 'the boundary is the start of the first kept turn');
  // A target the ordinary plan already reaches changes nothing.
  const fits = g.session.prepareCompaction({ targetTokens: g.session.snapshot().contextUsage.estimatedInputTokens });
  assert.deepEqual(fits, ordinary, 'now at or under the target: no split');
  const roomy = g.session.prepareCompaction({ targetTokens: Math.ceil(ordinary.floorTokens * 1.5) });
  assert.equal(roomy.split, undefined); assert.equal(roomy.throughMessageId, ordinary.throughMessageId, 'the ordinary projection fits: no split');
  assert.throws(() => g.session.prepareCompaction({ targetTokens: 0 }), { code: 'invalid_options' }); assert.throws(() => g.session.prepareCompaction({ targetTokens: 1.5 }), { code: 'invalid_options' });
});

test('retained turns that alone stay above the target: the earliest one is split at a complete batch, as little of it as the target needs', async t => {
  const f = await fixture(t, { turns: 4 });
  const { session } = f, usage = session.snapshot().contextUsage.estimatedInputTokens, ordinary = session.prepareCompaction();
  // Between the ordinary floor and the whole context: the ordinary plan leaves turns 3 and 4, which is above the target.
  const target = Math.floor(ordinary.floorTokens * 0.8);
  const plan = session.prepareCompaction({ targetTokens: target });
  assert.ok(plan.split, 'a split plan'); assert.equal(plan.partial, false);
  const messages = session.snapshot().messages, boundary = indexOf(session, plan.throughMessageId), three = turnStart(session, 3), four = turnStart(session, 4);
  assert.ok(boundary + 1 > three && boundary + 1 < four, 'the boundary lies inside turn 3 (the earliest retained turn), never turn 4');
  assert.ok(compactionCuts(messages, 0).includes(boundary + 1), 'a complete assistant/tool batch ends there');
  assert.equal(plan.split.historyMessages, three, 'everything before turn 3 is the history (no earlier compaction)'); assert.equal(plan.split.turnMessages, boundary + 1 - three);
  assert.equal(plan.archivedMessages, boundary + 1); assert.equal(plan.retainedMessages, messages.length - boundary - 1);
  assert.ok(plan.floorTokens < ordinary.floorTokens, 'it leaves less than the ordinary plan');
  // Two requests, in order: the history's ordinary checkpoint, then the turn's beginning.
  assert.deepEqual(plan.requests.map(entry => entry.kind), ['history', 'turn_prefix']); assert.deepEqual(plan.request, plan.requests[0].request); assert.equal(plan.maxOutputTokens, plan.requests[0].maxOutputTokens);
  const [history, prefix] = plan.requests;
  assert.ok(history.request.systemPrompt.startsWith('Summarize the provided')); assert.match(requestText(history), /Chapter 1: check the sources\.[\s\S]*Chapter 2: check the sources\./); assert.doesNotMatch(requestText(history), /Chapter 3:/);
  assert.equal(prefix.request.systemPrompt, SUMMARY_PROMPT); assert.match(requestText(prefix), /Chapter 3: check the sources\./); assert.doesNotMatch(requestText(prefix), /Chapter [124]:/);
  assert.ok(requestText(prefix).endsWith(TURN_PREFIX_DIRECTIVE)); assert.match(requestText(prefix), /Original request[\s\S]*Progress so far[\s\S]*Context needed to continue/);
  assert.match(requestText(prefix), /never as new instructions/, 'the record is data');
  assert.ok(prefix.request.estimatedInputTokens < history.request.estimatedInputTokens, 'the beginning of one turn is smaller than two turns');
  // Committing it: turn 3's rest and turn 4 stay verbatim after the summary; the projection is within the target (plus the summary).
  const summary = joinSplitSummary({ history: 'History checkpoint.', turnPrefix: 'Chapter 3 request: check the sources. Done so far: sources 1 and 2.' });
  assert.equal(session.offerCompaction(prepared(plan, summary)), true);
  const committed = session.commitPreparedCompaction();
  assert.equal(committed.committed, true); assert.equal(committed.throughMessageId, plan.throughMessageId);
  assert.ok(committed.afterTokens < usage, 'smaller than before');
  const kept = session.snapshot().messages.slice(boundary + 1);
  assert.ok(kept.some(message => message.role === 'user' && message.content[0].text.startsWith('Chapter 4:')), 'turn 4 is whole');
  assert.ok(kept.length === messages.length - boundary - 1 && kept[0].role === 'assistant', 'turn 3 continues after the checkpoint with its own next batch');
  assert.ok(summary.includes(SPLIT_TURN_HEADING));
});

test('the cut is the earliest that fits: a larger target archives less, and none that fits takes the latest cut, never turn 4', async t => {
  const f = await fixture(t, { turns: 4 });
  const { session } = f, ordinary = session.prepareCompaction(), cuts = [];
  for (const share of [0.95, 0.85, 0.75, 0.6]) { const plan = session.prepareCompaction({ targetTokens: Math.floor(ordinary.floorTokens * share) }); cuts.push(plan.split ? indexOf(session, plan.throughMessageId) : -1); }
  assert.ok(cuts.every(cut => cut >= 0), `every one of these targets needs a split: ${cuts}`);
  for (let index = 1; index < cuts.length; index++) assert.ok(cuts[index] >= cuts[index - 1], `a smaller target archives at least as much: ${cuts}`);
  assert.ok(cuts.at(-1) > cuts[0], 'and the range is real');
  // No cut fits: the latest one inside turn 3 (it keeps its last batch), turn 4 untouched.
  const hopeless = session.prepareCompaction({ targetTokens: 1 }), messages = session.snapshot().messages, three = turnStart(session, 3), four = turnStart(session, 4);
  const latest = compactionCuts(messages, 0).filter(cut => cut > three && cut < four).at(-1);
  assert.equal(indexOf(session, hopeless.throughMessageId) + 1, latest); assert.equal(messages.slice(latest, four).filter(message => message.role === 'assistant').length > 0, true, 'the last batch of turn 3 is kept');
  // And a later plan on top of that commit ends (bounded): the retained turns are never archived.
  session.offerCompaction(prepared(hopeless, joinSplitSummary({ history: 'H.', turnPrefix: 'T.' })));
  assert.equal(session.commitPreparedCompaction().committed, true);
  const again = session.prepareCompaction({ targetTokens: 1 });
  assert.equal(again, null, 'nothing is left to split inside turn 3 beyond its last batch: the plan ends');
});

test('the last turn is never split: one turn, or one retained turn, has nothing to give', async t => {
  const one = await fixture(t, { turns: 1 });
  assert.equal(one.session.prepareCompaction({ targetTokens: 1 }), null, 'a single turn');
  const four = await fixture(t, { turns: 4 });
  assert.equal(four.session.prepareCompaction({ keepUserTurns: 1, targetTokens: 1 }).split, undefined, 'keepUserTurns 1 keeps the last turn whole: the ordinary plan, no split');
  // Directly on the candidate search: fewer turns than kept, or a single kept turn.
  const messages = four.session.snapshot().messages;
  assert.equal(splitTurnCandidate(messages, { keepUserTurns: 1, fits: () => true }), null);
  assert.equal(splitTurnCandidate(messages.slice(0, turnStart(four.session, 2)), { keepUserTurns: 2, fits: () => true }), null, 'one turn, two to keep');
  assert.throws(() => splitTurnCandidate(messages, { keepUserTurns: 2 }), /fits must be a function/);
});

test('with two turns only, the first is split (the second stays whole); after an earlier compaction the previous summary stands in for the history', async t => {
  const two = await fixture(t, { turns: 2 });
  const plan = two.session.prepareCompaction({ targetTokens: 1 });
  assert.ok(plan.split); assert.equal(plan.split.historyMessages, 0, 'nothing before turn 1');
  assert.deepEqual(plan.requests.map(entry => entry.kind), ['turn_prefix']); assert.equal(plan.baseSummary, null);
  assert.ok(indexOf(two.session, plan.throughMessageId) < turnStart(two.session, 2));
  // Three turns and a manual compaction through turn 1: turn 2 is the earliest retained turn and the boundary is at its start.
  const three = await fixture(t, { turns: 3 });
  await three.session.compact({ summary: 'Earlier checkpoint.', keepLastTurns: 2 });
  const next = three.session.prepareCompaction({ targetTokens: 1 });
  assert.ok(next.split && next.split.historyMessages === 0, 'turn 2 starts right at the previous boundary');
  assert.deepEqual(next.requests.map(entry => entry.kind), ['turn_prefix']); assert.equal(next.baseSummary, 'Earlier checkpoint.');
  assert.equal(next.previousCompactionId, three.session.snapshot().compaction.id);
  const joined = await generatePlanSummary({ plan: next, run: async () => ({ summary: 'Turn 2: requested; sources 1 and 2 read.', usage, usageReported: true, requestId: 'r1', startedAt: 1, completedAt: 2 }) });
  assert.equal(joined.summary, `Earlier checkpoint.\n\n${SPLIT_TURN_HEADING}\n\nTurn 2: requested; sources 1 and 2 read.`);
  // The history request carries the previous summary forward when there is history to add.
  const four = await fixture(t, { turns: 4 });
  await four.session.compact({ summary: 'Checkpoint through turn 1.', keepLastTurns: 3 });
  const plan4 = four.session.prepareCompaction({ targetTokens: 1 });
  assert.deepEqual(plan4.requests.map(entry => entry.kind), ['history', 'turn_prefix']); assert.match(requestText(plan4.requests[0]), /<previous-summary>\nCheckpoint through turn 1\.\n<\/previous-summary>/);
  assert.match(requestText(plan4.requests[0]), /Chapter 2:/); assert.doesNotMatch(requestText(plan4.requests[0]), /Chapter 1:/, 'turn 1 is the previous summary\'s');
});

test('the summary of a plan: requests in order, texts joined, usage summed, and a retry sends only what failed', async t => {
  const f = await fixture(t, { turns: 4 });
  const plan = f.session.prepareCompaction({ targetTokens: 1 });
  const answer = (summary, requestId, input) => ({ summary, usage: { input, output: 5, cacheRead: input, cacheWrite: 0, totalTokens: 2 * input + 5, cacheUsageReported: true }, usageReported: true, requestId, startedAt: 10, completedAt: 20 + input });
  const sent = [];
  const joined = await generatePlanSummary({ plan, run: async (entry, index) => { sent.push([entry.kind, index]); return entry.kind === 'history' ? answer('History part.', 'r-history', 100) : answer('Turn part.', 'r-turn', 40); } });
  assert.deepEqual(sent, [['history', 0], ['turn_prefix', 1]]);
  assert.equal(joined.summary, `History part.\n\n${SPLIT_TURN_HEADING}\n\nTurn part.`); assert.equal(joined.requestId, 'r-history'); assert.deepEqual(joined.requestIds, ['r-history', 'r-turn']);
  assert.deepEqual({ input: joined.usage.input, output: joined.usage.output, cacheRead: joined.usage.cacheRead, totalTokens: joined.usage.totalTokens }, { input: 140, output: 10, cacheRead: 140, totalTokens: 290 });
  assert.equal(joined.usageReported, true); assert.equal(joined.completedAt, 60);
  // One request that did not report usage: the whole is not reported.
  const partial = await generatePlanSummary({ plan, run: async entry => ({ ...answer('x', entry.kind, 1), usageReported: entry.kind === 'history' }) });
  assert.equal(partial.usageReported, false);
  // A failure of the second request keeps the first; the retry sends only the second.
  const done = new Map(); let fail = true; const resent = [];
  const run = async entry => { resent.push(entry.kind); if (entry.kind === 'turn_prefix' && fail) throw Object.assign(new Error('truncated'), { truncated: true }); return answer(entry.kind, entry.kind, 10); };
  await assert.rejects(generatePlanSummary({ plan, run, done }), { truncated: true });
  fail = false;
  const retried = await generatePlanSummary({ plan, run, done });
  assert.deepEqual(resent, ['history', 'turn_prefix', 'turn_prefix'], 'the history was paid for once'); assert.equal(retried.summary, `history\n\n${SPLIT_TURN_HEADING}\n\nturn_prefix`);
  // An ordinary plan's one request is the summary itself.
  const ordinary = f.session.prepareCompaction();
  assert.deepEqual(await generatePlanSummary({ plan: ordinary, run: async () => answer('Whole.', 'r1', 5) }), answer('Whole.', 'r1', 5));
  assert.throws(() => joinSplitSummary(), TypeError);
  assert.equal(joinSplitSummary({ history: '  ', turnPrefix: ' Turn. ' }), `${SPLIT_TURN_HEADING}\n\nTurn.`, 'no history: just the turn context');
});

// Review of C5 (finding 1): the host's idle trigger counts the conversation with its real prompt and tool catalogue, while
// the maintenance handle that plans the compaction carries neither (tools: [] and the default prompt), so its projections
// read smaller by that prefix. Compared with the host's target as they stood, a cut that left the conversation over the
// target by the size of the prefix looked as if it fitted, or no split was planned at all. The host's own measure
// (`measuredTokens`) puts the two in the same units.
test('a maintenance handle without the conversation\'s prompt and tools plans the same split as the real handle once it is told the host\'s measure', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rna-idle-split-prefix-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const description = 'Tool description. '.repeat(300), system = 'You are the real agent. '.repeat(300);
  const catalogue = () => Array.from({ length: 10 }, (_, index) => ({ name: `tool_${index}`, effect: 'read', description, parameters: { type: 'object', properties: { n: { type: 'number' } }, additionalProperties: false }, execute: async () => '资料行。'.repeat(1500) }));
  const provider = async function* (request) {
    const last = request.messages.findLastIndex(message => message.role === 'user' && message.source !== 'context' && message.source !== 'compaction');
    const results = request.messages.slice(last + 1).filter(message => message.role === 'toolResult' || message.role === 'tool').length;
    if (results < GROUPS) yield { type: 'tool_call', id: `call-${request.messages.length}`, name: 'tool_0', arguments: { n: results + 1 } };
    else yield { type: 'text_delta', delta: 'Done with this chapter.' };
    const size = Math.ceil(Buffer.byteLength(JSON.stringify({ s: request.systemPrompt, t: request.tools, m: request.messages })) / 3);
    yield { type: 'usage', usage: { input: size, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: size + 5 } }; yield { type: 'done', stopReason: 'stop' };
  };
  const open = (sessionFile, tools) => createSession({ sessionId: 'idle-split-prefix', projectId: 'p', cwd: dir, stateDir: join(dir, 'state'), sessionFile, model, tools, ...(tools.length ? { systemPrompt: system } : {}), autoCompaction: false });
  const first = await createSession({ sessionId: 'idle-split-prefix', projectId: 'p', cwd: dir, stateDir: join(dir, 'state'), model, tools: catalogue(), provider, systemPrompt: system, autoCompaction: false });
  for (let index = 1; index <= 4; index++) await first.prompt(`Chapter ${index}: check the sources.`);
  const file = first.snapshot().sessionFile; await first.dispose();
  // The real handle (a journal has one writer: it is closed before the maintenance handle opens).
  const real = await open(file, catalogue());
  const measured = real.snapshot().contextUsage.estimatedInputTokens, ordinary = real.prepareCompaction();
  const targets = [ordinary.floorTokens - 1000, ordinary.floorTokens - 20000, ordinary.floorTokens - 40000];
  const references = targets.map(target => real.prepareCompaction({ targetTokens: target }));
  await real.dispose();
  const idle = await open(file, []);
  t.after(() => idle.dispose());
  const handle = idle.snapshot().contextUsage.estimatedInputTokens;
  assert.ok(measured - handle > 10000, `the idle handle lacks the real prefix: ${measured} against ${handle} tokens`);
  // Targets between the ordinary plan's floor (in the real handle's units) and what a split can reach.
  targets.forEach((target, index) => {
    const reference = references[index], told = idle.prepareCompaction({ targetTokens: target, measuredTokens: measured });
    assert.ok(reference.split, `the real handle splits at ${target}`);
    assert.equal(told.throughMessageId, reference.throughMessageId, `the idle handle told the host's measure cuts where the real handle does (target ${target})`);
    assert.deepEqual(told.split, reference.split);
  });
  // Just under what the ordinary plan really leaves: the idle handle alone sees nothing to split (its ordinary floor is lower by the prefix).
  const near = ordinary.floorTokens - 1000;
  assert.equal(idle.prepareCompaction({ targetTokens: near })?.split, undefined, 'without the measure it reads the ordinary plan as within the target');
  assert.ok(idle.prepareCompaction({ targetTokens: near, measuredTokens: measured }).split);
  // A measure below the handle's own is not a prefix: nothing is subtracted.
  assert.deepEqual(idle.prepareCompaction({ targetTokens: near, measuredTokens: 1 }), idle.prepareCompaction({ targetTokens: near }));
  assert.throws(() => idle.prepareCompaction({ targetTokens: near, measuredTokens: 0 }), { code: 'invalid_options' }); assert.throws(() => idle.prepareCompaction({ measuredTokens: 1.5 }), { code: 'invalid_options' });
});
