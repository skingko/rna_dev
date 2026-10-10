// The D4 harness's own pieces, without a host: the injected clock, the faux model's two mounts (the HTTP one read
// back through the SDK's real provider code), the fake JEV's wire answers and the unexplained-index-frame rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installClock, realNow } from './clock.mjs';
import { createFauxModel, decide, JUDGMENT_PLAN } from './faux-model.mjs';
import { createFakeJev, SYNTHETIC_JEV_KEY } from './fake-jev.mjs';
import { unexplainedIndexFrames } from './scenario.mjs';
import { streamCompletion } from '../../../../packages/sdk/src/providers.mjs';
import { createDecisionKernel } from '../../../../packages/sdk/src/decision-kernel.mjs';

test('the scenario clock shifts every Date reader, moves only forward and leaves real dates alone', t => {
  const clock = installClock({ start: '2030-01-01T00:00:00.000Z' });
  t.after(() => clock.uninstall());
  assert.ok(Math.abs(Date.now() - Date.parse('2030-01-01T00:00:00.000Z')) < 1000);
  assert.ok(Math.abs(new Date().getTime() - Date.now()) < 50);
  assert.equal(new Date(0).toISOString(), '1970-01-01T00:00:00.000Z', 'explicit dates are not shifted');
  const before = Date.now(); clock.advance(3600000);
  assert.ok(Date.now() - before >= 3600000);
  assert.throws(() => clock.advance(-1), /forward/);
  const dir = mkdtempSync(join(tmpdir(), 'rna-clock-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'f'), 'x');
  assert.ok(statSync(join(dir, 'f')).mtime instanceof Date, 'dates made by Node internals still pass instanceof Date');
  clock.uninstall();
  assert.ok(Math.abs(Date.now() - realNow()) < 50, 'uninstall restores the real clock');
});

test('the faux model plays each tag\'s script in order, then its default; both mounts record what they were sent', async t => {
  const faux = createFauxModel(); t.after(() => faux.close());
  faux.script('foreground', 'first', { toolCalls: [{ name: 'project_read', args: { path: 'a.txt' } }] });
  const read = async (provider, request) => { const events = []; for await (const event of provider(request)) events.push(event); return events; };
  const one = await read(faux.provider('foreground'), { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
  assert.deepEqual(one.filter(event => event.type === 'text_delta').map(event => event.delta).join(''), 'first');
  const two = await read(faux.provider('foreground'), { messages: [] });
  assert.equal(two.find(event => event.type === 'tool_call').name, 'project_read');
  assert.equal(two.at(-1).stopReason, 'toolUse');
  const three = await read(faux.provider('foreground'), { messages: [] });
  assert.equal(three.filter(event => event.type === 'text_delta').map(event => event.delta).join(''), 'OK.', 'the default once the script ran out');
  assert.deepEqual(faux.of('foreground').map(row => row.via), ['sdk', 'sdk', 'sdk']);

  // The HTTP mount speaks OpenAI chat completions: read it back through the SDK's own provider.
  const baseUrl = await faux.listen();
  faux.script('http', { text: 'Summary text.', chunks: 3 });
  const model = { providerId: 'faux', modelId: 'faux-model', protocol: 'openai', baseUrl, contextWindow: 32000, maxOutputTokens: 500, reasoning: 'off' };
  const events = await read(streamCompletion, { model, apiKey: 'scenario-synthetic-model-key', systemPrompt: 'Summarize.', messages: [{ role: 'user', content: [{ type: 'text', text: 'The record.' }] }], tools: [] });
  assert.equal(events.filter(event => event.type === 'text_delta').map(event => event.delta).join(''), 'Summary text.');
  assert.ok(events.some(event => event.type === 'usage'));
  assert.match(faux.of('http')[0].wire, /The record\./, 'the wire body is kept');
});

test('decide() writes a decision of the initiative contract, with the judgment plan when the host asks for one', () => {
  const input = { events: [{ id: 'E1' }, { id: 'E2' }], hostConditions: { judgment: { requiresAssessment: true } } };
  const decision = JSON.parse(decide(input, 'work', 'Tidy the notes.').text);
  assert.deepEqual([decision.action, decision.content, decision.evidenceIds], ['work', 'Tidy the notes.', ['E2']]);
  assert.ok(decision.judgmentPolicy?.questions?.task_state);
  assert.equal(JSON.parse(decide({ events: [] }, 'wait').text).judgmentPolicy, undefined);
});

test('the fake JEV answers in the wire format the kernel parses: abstentions take the fallback, answers become verdicts', async t => {
  const jev = await createFakeJev(); t.after(() => jev.close());
  const kernel = createDecisionKernel({ apiKey: () => SYNTHETIC_JEV_KEY, endpoint: jev.endpoint, mode: 'active' }); t.after(() => kernel.close());
  const ask = state => kernel.decide({ point: 'initiative.review', scope: { projectId: 'fixture' }, state, assessmentPlan: structuredClone(JUDGMENT_PLAN), fallback: { review: true } });
  const abstained = await ask({ fixture: 'abstain' });
  assert.equal(jev.calls.length, 1); assert.equal(jev.calls[0].authorization, true, 'the synthetic key is sent as a bearer token');
  assert.deepEqual([abstained.source, abstained.reason], ['fallback', 'abstain'], JSON.stringify(abstained).slice(0, 300));
  jev.answer('initiative_need', 0.97); kernel.clear(); // the same state would be answered from the kernel's cache
  const answered = await ask({ fixture: 'answered' });
  assert.equal(jev.calls.length, 2);
  assert.equal(answered.source, 'judge', JSON.stringify({ answers: answered.answers, reason: answered.reason }).slice(0, 600));
  assert.equal(answered.answers.initiative_need.probability, 0.97);
});

test('index frames are explained only by a newer revision on their own stream; index resyncs never are', () => {
  const frame = (stream, event, data, at) => ({ stream, event, data, at });
  const frames = [
    frame('index', 'hello', { revision: 5 }, 1), frame('index', 'index', { revision: 6 }, 2), frame('index', 'index', { revision: 6 }, 3),
    frame('session', 'hello', { revision: 5 }, 1), frame('session', 'items.upsert', { revision: 7 }, 4), frame('session', 'index', { revision: 7 }, 5),
    frame('index', 'resync', { reason: 'event_too_large', projectIds: ['p'] }, 6), frame('index', 'resync', { reason: 'resume_unavailable' }, 7),
  ];
  assert.deepEqual(unexplainedIndexFrames(frames).map(row => `${row.stream}@${row.at}`), ['index@3', 'index@6']);
  assert.deepEqual(unexplainedIndexFrames(frames, { since: 4 }).map(row => `${row.stream}@${row.at}`), ['index@6']);
});
