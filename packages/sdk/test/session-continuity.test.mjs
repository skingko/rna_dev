import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../src/session.mjs';
import { solidPng } from '../src/vision-probe.mjs';

// Spec p1 compaction §A1: every model request carries `ledger.continuity` for the host's metering — whether its
// projected messages extend the last served request's byte for byte (structural continuity), the gap since that
// request started, and that request's prompt size. Edits of earlier history (settle, fold, forget, compaction, image
// offload, history images, model or prefix change) break continuity; appends never do.
const model = { providerId: 'continuity-fixture', modelId: 'fixture', protocol: 'openai', baseUrl: 'http://127.0.0.1:9', contextWindow: 1000000, maxOutputTokens: 500, reasoning: 'off' };
const usage = { input: 40, output: 5, cacheRead: 160, cacheWrite: 0, totalTokens: 205, cacheUsageReported: true };
const fileTools = [
  { name: 'read', effect: 'read', description: 'Read a fixture file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false }, execute: async (_id, args) => `${args.path}: ${'内容'.repeat(1500)}` },
  { name: 'write', effect: 'write', description: 'Write a fixture file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, additionalProperties: false }, execute: async (_id, args) => `wrote ${args.path}` }
];
/** The last message that is not host context: a user prompt asks for a tool, anything else gets an answer. */
const lastReal = request => request.messages.findLast(message => message.source !== 'context');

async function fixture(t, { tools = fileTools, decide, ...options } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'rna-continuity-')), requests = [], handles = [];
  let now = Date.parse('2026-10-04T08:00:00Z'), calls = 0;
  const clock = () => now;
  const provider = async function* (request) {
    requests.push({ ledger: structuredClone(request.ledger), messages: JSON.stringify(request.messages), system: request.systemPrompt, tools: JSON.stringify(request.tools), purpose: request.purpose });
    const action = decide?.(request, ++calls) ?? (lastReal(request)?.role === 'user' ? 'read' : 'text');
    if (action === 'read') yield { type: 'tool_call', id: `call-${calls}`, name: 'read', arguments: { path: `f${calls}.md` } };
    else if (action === 'write') yield { type: 'tool_call', id: `call-${calls}`, name: 'write', arguments: { path: `ch${calls}.md`, content: `第${calls}章 ${'正文'.repeat(800)}` } };
    else yield { type: 'text_delta', delta: `answer ${calls}` };
    yield { type: 'usage', usage }; yield { type: 'done', stopReason: action === 'text' ? 'stop' : 'toolUse' };
  };
  const args = { sessionId: 'continuity', projectId: 'continuity-project', cwd: dir, stateDir: join(dir, 'state'), model, tools, provider, clock, ...options };
  const create = async extra => { const session = await createSession({ ...args, ...extra }); handles.push(session); return session; };
  t.after(async () => { await Promise.allSettled(handles.map(session => session.dispose())); await rm(dir, { recursive: true, force: true }); });
  return { session: await create(), create, requests, advance: ms => { now += ms; } };
}

test('the provider receives continuity: null first, then continuous within a run and across a reopen, with the clock gap and prompt size', async t => {
  const f = await fixture(t);
  await f.session.prompt('Read one file.');
  assert.equal(f.requests[0].ledger.continuity, null, 'nothing was served before');
  assert.deepEqual(f.requests[1].ledger.continuity, { continuous: true, gapMs: 0, previousPromptTokens: 200 });
  const { sessionFile } = f.session.snapshot(); await f.session.dispose();
  f.advance(5 * 60000);
  const reopened = await f.create({ sessionFile });
  await reopened.prompt('Read another.');
  assert.deepEqual(f.requests[2].ledger.continuity, { continuous: true, gapMs: 5 * 60000, previousPromptTokens: 200 }, 'replayed messages keep the metadata continuity compares');
  assert.ok(f.requests[2].messages.startsWith(f.requests[1].messages.slice(0, -1)), 'a continuous request extends the previous projection');
});

test('a prefix change, a model change, a compaction and history images each break continuity', async t => {
  let extra = false;
  const f = await fixture(t, { beforeRequest: () => extra ? { tools: [...fileTools, { name: 'note', effect: 'read', parameters: { type: 'object', properties: {} }, execute: async () => 'ok' }] } : undefined });
  await f.session.prompt('One.');
  extra = true; await f.session.prompt('Two.');
  assert.equal(f.requests[2].ledger.continuity.continuous, false, 'tools changed: the prefix changed');
  assert.equal(f.requests[3].ledger.continuity.continuous, true);
  f.session.setModel({ ...model, modelId: 'other' }); await f.session.prompt('Three.');
  assert.equal(f.requests[4].ledger.continuity.continuous, false, 'another model');
  const compacted = await f.session.compact({ summary: 'Earlier reads summarized.', keepLastTurns: 1 });
  assert.equal(compacted.compacted, true);
  await f.session.prompt('Four.');
  assert.equal(f.requests[6].ledger.continuity.continuous, false, 'a compaction replaced history');
  assert.equal(f.requests[7].ledger.continuity.continuous, true);
  // A vision model keeps an observed image for the last two user turns; when it becomes a text placeholder the projection changed.
  let shots = 0;
  const g = await fixture(t, { model: { ...model, input: ['text', 'image'] }, tools: [{ name: 'read', effect: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } }, execute: async () => shots++ ? 'no image this time' : ({ content: [{ type: 'image', data: solidPng(8).toString('base64'), mimeType: 'image/png' }] }) }] });
  for (const text of ['Look.', 'Two.', 'Three.']) await g.session.prompt(text);
  assert.deepEqual(g.requests.map(request => request.ledger.continuity?.continuous ?? null), [null, true, true, true, false, true], 'turn three: the turn-one image left the recent window');
  assert.match(g.requests[4].messages, /image/i);
});

test('folds and forgets at a cold economy point break continuity; warm requests stay continuous', async t => {
  let round = 0, forget = false;
  const f = await fixture(t, { cacheSurvivalMs: 60 * 60000,
    beforeRequest: () => ({ contextUpdates: [{ key: 'project-notes', source: 'host-notes', text: `notes revision ${round}` }] }),
    forgetStale: async input => forget ? input.results.map(row => row.id) : [] });
  for (const index of [1, 2, 3]) { round = index; await f.session.prompt(`Read file ${index}.`); }
  assert.ok(f.requests.slice(1).every(request => request.ledger.continuity.continuous), 'warm: nothing below the settle share is committed');
  f.advance(2 * 60 * 60000); round = 4; forget = true;
  await f.session.prompt('Read file 4.');
  const cold = f.requests.at(-2);
  assert.equal(cold.ledger.continuity.continuous, false, 'cold: folds and forgets were committed before this request');
  assert.ok(cold.ledger.continuity.gapMs >= 2 * 60 * 60000);
  assert.match(cold.messages, /Superseded: a later update of \\"project-notes\\"/);
  assert.match(cold.messages, /result set aside: later work superseded it/);
  assert.equal(f.requests.at(-1).ledger.continuity.continuous, true, 'the next request extends the edited projection');
});

// ECON-2: a foreground cold break nearly always folds or settles something, so the first request after a long gap
// is never structurally continuous. What it left unchanged (the previous request's messages before the first edit)
// still tells whether the cache survived: the ledger gets `continuity.edited.comparableTokens` and the gap is a sample.
test('an edited cold request carries the part of the previous prompt it left unchanged, so a long gap is still a survival sample', async t => {
  const { survivalSample, requestContinuity, SURVIVAL_EDITED_MIN_SHARE } = await import('../src/cache-survival.mjs');
  let round = 0, early = false;
  const f = await fixture(t, { cacheSurvivalMs: 137 * 60000,
    beforeRequest: () => ({ contextUpdates: [...(round > 1 ? [{ key: 'turn-route-hints', source: 'host-turn-routing', scope: 'turn', text: `hints ${round}` }] : []), ...(round === 1 || early ? [{ key: 'notes', source: 'host-notes', text: `notes ${early ? 'revised' : 'first'}` }] : [])] }) });
  // A long first turn, then warm turns whose notes end with them: the cold break folds what the warm turns left.
  for (const index of [1, 2, 3]) { round = index; f.advance(2 * 60000); await f.session.prompt(index === 1 ? `Background: ${'资料'.repeat(4000)}` : `Read file ${index}.`); }
  f.advance(200 * 60000); round = 4;
  await f.session.prompt('Read file 4.');
  const cold = f.requests.at(-2), previous = f.requests.at(-3), continuity = cold.ledger.continuity;
  assert.equal(continuity.continuous, false, 'the cold break folded the ended turn notes');
  assert.ok(continuity.edited?.comparableTokens > SURVIVAL_EDITED_MIN_SHARE * continuity.previousPromptTokens && continuity.edited.comparableTokens <= continuity.previousPromptTokens, JSON.stringify(continuity));
  // The messages before the first edited one are the previous request's own, byte for byte.
  const before = JSON.parse(previous.messages), after = JSON.parse(cold.messages), first = after.findIndex((message, index) => JSON.stringify(message) !== JSON.stringify(before[index]));
  assert.match(JSON.stringify(after[first]), /(Superseded: a later update of|Set aside:) \\"turn-route-hints\\"/, 'the first difference is the folded note');
  const at = Date.parse('2026-10-04T12:00:00Z');
  assert.equal(survivalSample({ continuity, cacheReported: true, cacheRead: continuity.edited.comparableTokens, at }).warm, true, 'read from cache: warm after 200 minutes');
  assert.deepEqual(survivalSample({ continuity, cacheReported: true, cacheRead: 0, at }), { gapMs: continuity.gapMs, warm: false, prompt: continuity.edited.comparableTokens, at }, 'nothing read: cold');
  assert.equal(survivalSample({ continuity: { ...continuity, edited: undefined }, cacheReported: true, cacheRead: 0, at }), null, 'without the unchanged part it says nothing');
  // The journaled message carries what the host's backfill needs to rebuild the same block.
  const messages = f.session.snapshot().messages, sent = messages.filter(message => message.role === 'assistant');
  const coldMessage = sent.find(message => message.contextEdits), served = sent[sent.indexOf(coldMessage) - 1];
  assert.deepEqual(requestContinuity(served, coldMessage), continuity);
  assert.equal(f.requests.at(-1).ledger.continuity.edited, undefined, 'the next request is continuous again');
  // An edit near the start of the prompt (a superseded copy from the first turn) leaves too little to compare.
  f.advance(200 * 60000); round = 5; early = true;
  await f.session.prompt('Read file 5.');
  const edited = f.requests.at(-2).ledger.continuity;
  assert.equal(edited.continuous, false);
  assert.equal(survivalSample({ continuity: edited, cacheReported: true, cacheRead: 0, at }), null, `below ${SURVIVAL_EDITED_MIN_SHARE} of the previous prompt unchanged: no sample`);
});

test('property: a structurally continuous request is a byte-prefix extension of the previous one', async t => {
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let continuousTotal = 0, brokenTotal = 0;
  for (let run = 0; run < 8; run++) {
    let revision = 0;
    const f = await fixture(t, {
      cacheSurvivalMs: 30 * 60000,
      settleArguments: (name, args) => name === 'write' && random() < .7 ? { ...args, content: '[written to the file]' } : null,
      forgetStale: async input => input.results.filter(() => random() < .3).map(row => row.id),
      beforeRequest: () => random() < .4 ? { contextUpdates: [{ key: random() < .5 ? 'notes' : 'plan', source: 'host-notes', text: `r${++revision}`, ...(random() < .3 ? { scope: 'turn' } : {}) }] } : undefined,
      decide: request => { const last = lastReal(request); return last?.role === 'user' ? (random() < .5 ? 'write' : 'read') : last?.role === 'toolResult' && random() < .4 ? 'read' : 'text'; }
    });
    for (let turn = 0; turn < 10; turn++) {
      if (random() < .25) f.advance(45 * 60000); else f.advance(Math.floor(random() * 5 * 60000));
      if (turn > 2 && random() < .1) await f.session.compact({ summary: `summary ${turn}`, keepLastTurns: 1 });
      await f.session.prompt(`Turn ${turn}: ${'材料'.repeat(Math.floor(random() * 400))}`);
    }
    for (let index = 1; index < f.requests.length; index++) {
      const previous = f.requests[index - 1], current = f.requests[index];
      if (current.ledger.continuity?.continuous) {
        continuousTotal++;
        assert.equal(current.system, previous.system); assert.equal(current.tools, previous.tools);
        assert.ok(current.messages.startsWith(previous.messages.slice(0, -1)), `request ${index} of run ${run} claims continuity but rewrote earlier messages`);
      } else brokenTotal++;
    }
  }
  assert.ok(continuousTotal > 20 && brokenTotal > 3, `both kinds were exercised (${continuousTotal} continuous, ${brokenTotal} broken)`);
});
