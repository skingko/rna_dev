import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { proposeProjectGenome } from '../src/project-evolution.mjs';
import { bootstrapProject } from '../src/bootstrap.mjs';
import { reviewAuthoringFormat } from '../src/reference-authoring.mjs';
import { projectGenomeFixture, diagnosisFixture } from './fixtures/project-genome.mjs';

const model = { providerId: 'finish-format-fixture', modelId: 'fixture', protocol: 'openai', contextWindow: 128000, maxOutputTokens: 8192, reasoning: 'off' };
const context = { schemaVersion: 1, evidence: [], files: [{ path: 'source.js', content: 'const verified = false;' }] };
const proposal = () => { const genome = projectGenomeFixture({ candidate: true }); genome.tools = [{ id: 'evidence_helper', inheritFromBaseline: true }]; delete genome.evaluationSuite; return { summary: 'Check recorded outcomes', hypothesis: 'A reusable method reduces unchecked claims', diagnosis: diagnosisFixture(), changes: ['Improve the interpretation method'], genome }; };
const initialization = () => ({ overview: 'Review evidence', focus: 'Check the next observation', facts: [], openQuestions: [], milestones: [], assignments: { skillIds: [], toolIds: [], mcpServerIds: [], reasons: [] }, unmetCapabilities: [], genome: projectGenomeFixture() });
const usage = { input: 10, output: 3, totalTokens: 13 };
const refs = [{ name: 'marketplace_read', effect: 'read', parameters: { type: 'object' }, execute: async () => assert.fail('A prose answer must not invent tool execution') }];
const base = { project: { id: 'author-finish-format' }, baseline: projectGenomeFixture(), evidence: [], model, learningContext: context, maxAttempts: 1 };
const feedbackRows = events => events.filter(row => row.type === 'author_format_feedback' || row.type === 'bootstrap_format_feedback');

async function endpoint(t, kind, { readFirst = false, badTail = false, attempts = 1 } = {}) {
  const calls = [], errors = [], server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const part of request) raw += part;
      const body = JSON.parse(raw), number = calls.push(body), step = (number - 1) % 6 + 1;
      assert.ok(number <= 6 * attempts, 'Finish feedback must never increase the existing request ceiling');
      const messages = body.messages, feedback = messages.filter(message => message.role === 'user' && message.content.includes('host:author-output-contract'));
      assert.equal(feedback.length, step - 1 - (readFirst && step > 1 ? 1 : 0));
      for (const message of feedback) { assert.match(message.content, /not one complete JSON object/); assert.match(message.content, /no new project evidence, permissions or request allowance/); assert.equal(message.content.includes('PRIVATE_EARLY_PROSE'), false); }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } } : {}) })}\n\n`);
      if (readFirst && step === 1) {
        assert.ok(body.tools.some(tool => tool.function.name === 'learning_context_read'));
        send({ tool_calls: [{ index: 0, id: `read-${number}`, type: 'function', function: { name: 'learning_context_read', arguments: '{"id":"file:source.js"}' } }] }); send({}, 'tool_calls');
      } else {
        if (step < 6) { assert.ok(body.tools.length); assert.equal(body.response_format, undefined); assert.equal(body.tool_choice, undefined); }
        else { assert.equal(body.tools?.length ?? 0, 0); assert.deepEqual(body.response_format, { type: 'json_object' }); assert.equal(body.tool_choice, 'none'); assert.match(messages[0].content, /Tools are unavailable in this final response/); }
        if (readFirst && step > 1) { assert.equal(messages.filter(message => message.role === 'tool').length, 1); assert.equal(messages.find(message => message.role === 'tool').tool_call_id, 'read-1'); }
        const content = step < 6 || badTail ? `PRIVATE_EARLY_PROSE_${number}: I have completed research. ${JSON.stringify({ partial: true })}` : JSON.stringify(kind === 'initialization' ? initialization() : proposal());
        send({ content }); send({}, 'stop');
      }
      response.end('data: [DONE]\n\n');
    } catch (error) { errors.push(error); if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.deepEqual(errors, []); });
  return { calls, model: { ...model, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, compat: { supportsJsonObject: true, supportsToolChoiceNone: true } } };
}

for (const kind of ['learning', 'reference', 'initialization']) test(`HTTP ${kind} early prose receives five bounded host checks then one native JSON final response`, async t => {
  const app = await endpoint(t, kind), events = [], receipts = [];
  const result = kind === 'initialization' ? await bootstrapProject({ title: 'Evidence method', model: app.model, catalog: {}, referenceTools: refs, maxAttempts: 1, onEvent: event => events.push(event) })
    : await proposeProjectGenome({ ...base, model: app.model, ...(kind === 'reference' ? { learningContext: undefined, referenceTools: refs } : {}), onProgress: event => events.push(event), requestControl: { onUsage: row => receipts.push(row) } });
  assert.equal(app.calls.length, 6); assert.equal(result.attempts, 1); assert.equal(result.usage.totalTokens, 78);
  assert.equal(kind === 'initialization' ? result.status === 'ready' : result.validation.passed, true);
  assert.deepEqual(feedbackRows(events).map(row => row.continuations), [1, 2, 3, 4, 5]); assert.equal(new Set(feedbackRows(events).map(row => row.messageId)).size, 5); assert.equal(JSON.stringify(feedbackRows(events)).includes('PRIVATE_EARLY_PROSE'), false);
  if (kind !== 'initialization') { assert.equal(receipts.length, 6); assert.ok(receipts.every(row => row.completed && row.usageReported)); }
});

test('HTTP format feedback continues with already executed read receipts and never replays the read', async t => {
  const app = await endpoint(t, 'learning', { readFirst: true }), events = [];
  const result = await proposeProjectGenome({ ...base, model: app.model, onProgress: event => events.push(event) });
  assert.equal(app.calls.length, 6); assert.equal(result.validation.passed, true); assert.equal(result.learningContextReads.length, 1); assert.equal(feedbackRows(events).length, 4); assert.equal(result.usage.totalTokens, 78);
});

test('HTTP malformed reserved finals stay strict and stop at the original three attempts and eighteen requests', async t => {
  const app = await endpoint(t, 'learning', { badTail: true, attempts: 3 }), events = [];
  await assert.rejects(proposeProjectGenome({ ...base, model: app.model, maxAttempts: 3, onProgress: event => events.push(event) }), error => {
    assert.equal(error.code, 'invalid_output'); assert.equal(error.repairEvidence.length, 3); assert.equal(error.requests.length, 18); assert.equal(error.usage.totalTokens, 234); assert.equal(error.learningContextReads.length, 0); return true;
  });
  assert.equal(app.calls.length, 18); assert.deepEqual(feedbackRows(events).map(row => row.continuations), [1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 1, 2, 3, 4, 5]);
});

test('author finish shape check requires one entire object and never extracts JSON from mixed text', () => {
  const signal = new AbortController().signal, message = text => ({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] });
  for (const text of ['{}', ' {"x":1} ', '```json\n{"x":1}\n```', '```\n{}\n```']) assert.equal(reviewAuthoringFormat({ message: message(text), signal }), undefined);
  const invalid = ['', '  ', 'I am ready', '[]', 'null', '1', 'true', '"text"', '{"partial":', '{} {}', 'Here: {"x":1}', '```json\n{}\n``` trailing', '```json\n{}\n```\n```json\n{}\n```', 'DSML<tool_calls>{}'];
  const feedback = invalid.map(text => reviewAuthoringFormat({ message: message(text), signal }));
  assert.ok(feedback.every(result => result.feedback.length === 1 && result.feedback[0].source === 'host:author-output-contract')); assert.ok(feedback.every(result => JSON.stringify(result) === JSON.stringify(feedback[0])), 'Feedback is fixed host data, never echoed response text');
  assert.equal(reviewAuthoringFormat({ message: { ...message('not JSON'), source: 'step-limit-summary' }, signal }), undefined);
});

test('a complete early JSON object or anchored fence can finish without buying a reserved final request', async () => {
  for (const fenced of [false, true]) {
    let calls = 0; const events = [], output = JSON.stringify(proposal());
    const result = await proposeProjectGenome({ ...base, onProgress: event => events.push(event), provider: async function* () { calls++; yield { type: 'text_delta', delta: fenced ? `\`\`\`json\n${output}\n\`\`\`` : output }; yield { type: 'usage', usage }; yield { type: 'done', stopReason: 'stop' }; } });
    assert.equal(calls, 1); assert.equal(result.validation.passed, true); assert.equal(result.usage.totalTokens, 13); assert.equal(feedbackRows(events).length, 0);
  }
});

test('an early complete object is still rejected by the original business schema instead of accepted by format feedback', async () => {
  let calls = 0; const events = [];
  await assert.rejects(proposeProjectGenome({ ...base, onProgress: event => events.push(event), provider: async function* () { calls++; yield { type: 'text_delta', delta: '{}' }; yield { type: 'usage', usage }; yield { type: 'done', stopReason: 'stop' }; } }), error => error.code === 'invalid_output' && error.usage.totalTokens === 13);
  assert.equal(calls, 1); assert.equal(feedbackRows(events).length, 0);
});

for (const stopReason of ['length', 'unknown']) test(`early ${stopReason} responses are not reclassified as normal completed format failures`, async () => {
  let calls = 0; const events = [];
  await assert.rejects(proposeProjectGenome({ ...base, onProgress: event => events.push(event), provider: async function* () { calls++; yield { type: 'text_delta', delta: 'unfinished prose' }; yield { type: 'usage', usage }; yield { type: 'done', stopReason }; } }), error => error.code === 'invalid_output' && error.usage.totalTokens === 13);
  assert.equal(calls, 1); assert.equal(feedbackRows(events).length, 0);
});

for (const denied of ['budget', 'cancel']) test(`format feedback cannot override ${denied} before its next provider request`, async () => {
  let calls = 0, admissions = 0; const controller = new AbortController(), events = [];
  await assert.rejects(proposeProjectGenome({ ...base, signal: controller.signal, onProgress: event => { events.push(event); if (denied === 'cancel' && event.type === 'author_format_feedback') controller.abort(Object.assign(new Error('Host cancelled authoring'), { code: 'cancelled' })); }, requestControl: { beforeRequest: () => { if (++admissions === 2 && denied === 'budget') throw Object.assign(new Error('No allowance'), { code: 'budget_exhausted' }); } }, provider: async function* () { calls++; yield { type: 'text_delta', delta: 'A narrative progress report.' }; yield { type: 'usage', usage }; yield { type: 'done', stopReason: 'stop' }; } }), error => error.code === (denied === 'budget' ? 'budget_exhausted' : 'cancelled') && error.usage.totalTokens === 13);
  assert.equal(calls, 1); assert.equal(admissions, denied === 'budget' ? 2 : 1); assert.equal(feedbackRows(events).length, 1);
});
